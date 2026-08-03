import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
	TestCaseMeta,
	collectTestCases,
	resolveDataset,
	evalCargoDir,
	evalLibPath,
	frac,
	avg,
	hitAtK,
	hitAny,
	categoriesOf,
	metaCategories,
	isExactMatch,
	renderTextTable,
	renderMarkdownTable,
} from './evalShared';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Version sorting key
function raVersionKey(dirName: string): number[] {
	const m = /rust-analyzer-(\d+)\.(\d+)\.(\d+)/.exec(dirName);
	return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
}

// Find the rust-analyzer binary in a VSCode extension install
function findVscodeRaBin(): string | undefined {
	const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
	let entries: string[];
	try { entries = fs.readdirSync(extRoot); } catch { return undefined; }

	return entries
		.filter((name) => name.startsWith('rust-lang.rust-analyzer-'))
		.sort((a, b) => {
			const [ka, kb] = [raVersionKey(a), raVersionKey(b)];
			for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
			return 0;
		})
		.map((name) => path.join(extRoot, name, 'server', 'rust-analyzer'))
		.find((bin) => fs.existsSync(bin));
}

// Falls back to whatever is on PATH if no extension copy is installed.
const RA_BIN = process.env.RA_BIN || findVscodeRaBin() || 'rust-analyzer';

// K cutoffs reported in the summary tables.
const K_CUTOFFS = [1, 5, 10];

// Search budget handed to rust-analyzer's term search (default is 200).
const TERM_SEARCH_FUEL = 1000;

// rust-analyzer returns an empty list while it is still analysing a freshly
// opened document, so completions are retried before being treated as a miss.
const COMPLETION_ATTEMPTS = 4;
const COMPLETION_RETRY_MS = 400;

// Prepended to every hole program so warnings don't crowd out completions.
const SOURCE_HEADER = '#![allow(warnings)]\n';

const evalLibUri = pathToFileURL(evalLibPath).toString();

const { dataset, datasetDir: generatedDir } = resolveDataset('assignments_no_types');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : Infinity;

// How many of rust-analyzer's returned completions to record per hole.
const maxItemsArg = process.argv.find((arg) => arg.startsWith('--max-items='));
const maxItemsRaw = maxItemsArg?.slice('--max-items='.length);
const MAX_RECORDED_ITEMS =
	maxItemsRaw === undefined ? 25
	: maxItemsRaw === 'all' ? Infinity
	: parseInt(maxItemsRaw, 10) || Infinity;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// One completion as rust-analyzer returned it
interface RecordedCompletion {
	rank: number;
	label: string;
	insertion: string;
	kind?: string;
	detail?: string;
	sortText?: string;
	matched?: boolean;
}

interface RaResult {
	task: string;
	hole: string;
	holeCategories: string[];
	original: string;
	expected_type?: string;
	error?: string;
	completion_count: number;
	exact_rank: number | null;
	completions: RecordedCompletion[];
}

// ---------------------------------------------------------------------------
// Minimal stdio LSP client
// ---------------------------------------------------------------------------

class LspClient {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
	private lastProgress = 0;
	private sawProgress = false;

	constructor(bin: string, cwd: string) {
		this.proc = spawn(bin, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr.on('data', () => {/* rust-analyzer logs; ignore */});
		// RA_BIN may be a bare name resolved off PATH, so spawn itself can fail.
		this.proc.on('error', (err) => {
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
		});
		this.proc.on('exit', (code) => {
			for (const { reject } of this.pending.values()) reject(new Error(`rust-analyzer exited (${code})`));
			this.pending.clear();
		});
	}

	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		// Parse as many complete framed messages as are buffered.
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString('ascii');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
			const len = parseInt(match[1], 10);
			const start = headerEnd + 4;
			if (this.buffer.length < start + len) return; // wait for more
			const body = this.buffer.subarray(start, start + len).toString('utf8');
			this.buffer = this.buffer.subarray(start + len);
			try { this.dispatch(JSON.parse(body)); } catch {/* ignore malformed */}
		}
	}

	private dispatch(msg: any) {
		if (msg.method === '$/progress') {
			this.sawProgress = true;
			this.lastProgress = Date.now();
			return;
		}
		// Answer server->client requests so rust-analyzer doesn't stall.
		if (msg.method && msg.id !== undefined) {
			this.respond(msg.id, null);
			return;
		}
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
			else resolve(msg.result);
		}
	}

	private send(obj: any) {
		const json = JSON.stringify(obj);
		const payload = Buffer.from(json, 'utf8');
		this.proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
		this.proc.stdin.write(payload);
	}

	private respond(id: any, result: any) {
		this.send({ jsonrpc: '2.0', id, result });
	}

	request<T = any>(method: string, params: any): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: any) {
		this.send({ jsonrpc: '2.0', method, params });
	}

	async waitUntilIdle(quietMs = 4000, capMs = 180000): Promise<void> {
		const startedAt = Date.now();
		this.lastProgress = Date.now();
		for (;;) {
			await delay(500);
			const now = Date.now();
			if (this.sawProgress && now - this.lastProgress > quietMs) return;
			if (now - startedAt > capMs) return;
		}
	}

	shutdown() {
		try { this.notify('exit', null); } catch {/* noop */}
		this.proc.kill();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

// Strip LSP snippet
function stripSnippet(text: string): string {
	return text
		.replace(/\$\{\d+:([^{}]*)\}/g, '$1') // ${1:name} -> name
		.replace(/\$\{\d+\}/g, '')            // ${1}      -> ''
		.replace(/\$\d+/g, '')                // $0        -> ''
		.replace(/\\\$/g, '$');               // unescape literal $
}

// Text rust-analyzer would actually insert for a completion item.
function insertionOf(item: any): string {
	if (typeof item.insertText === 'string') return stripSnippet(item.insertText);
	if (item.textEdit && typeof item.textEdit.newText === 'string') return stripSnippet(item.textEdit.newText);
	return item.label ?? '';
}

// LSP CompletionItemKind, so the recorded list is readable without a spec lookup.
const COMPLETION_ITEM_KINDS = [
	'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface',
	'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File',
	'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
];

function kindName(kind: unknown): string | undefined {
	if (typeof kind !== 'number') return undefined;
	return COMPLETION_ITEM_KINDS[kind - 1] ?? String(kind);
}

function recordCompletions(items: any[], exactRank: number | null): RecordedCompletion[] {
	const project = (item: any, rank: number): RecordedCompletion => ({
		rank,
		label: item.label ?? '',
		insertion: insertionOf(item),
		kind: kindName(item.kind),
		detail: item.detail,
		sortText: item.sortText,
		...(rank === exactRank ? { matched: true } : {}),
	});

	const kept = items.slice(0, MAX_RECORDED_ITEMS).map(project);
	if (exactRank !== null && exactRank >= kept.length) kept.push(project(items[exactRank], exactRank));
	return kept;
}

function bestRank(items: any[], predicate: (insertion: string, label: string) => boolean): number | null {
	for (let i = 0; i < items.length; i++) {
		const insertion = insertionOf(items[i]);
		const label = items[i].label ?? '';
		if (predicate(insertion, label)) return i;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Per-hole evaluation
// ---------------------------------------------------------------------------

/** Convert the `??` offset in the source into a 0-indexed LSP position and the hole-free text. */
function holePositionAndText(rustCode: string): { text: string; line: number; character: number } | null {
	const idx = rustCode.indexOf('??');
	if (idx === -1) return null;
	const text = rustCode.slice(0, idx) + rustCode.slice(idx + 2);
	const before = rustCode.slice(0, idx);
	const nl = before.lastIndexOf('\n');
	const line = (before.match(/\n/g)?.length) ?? 0;
	const character = idx - (nl + 1);
	return { text, line, character };
}

async function evalHoleWithRa(
	client: LspClient,
	version: number,
	rustCode: string,
	meta: TestCaseMeta
): Promise<{ error?: string; count: number; items: any[]; line: number; character: number }> {
	const pos = holePositionAndText(rustCode);
	if (!pos) return { error: 'no ?? marker in source', count: 0, items: [], line: 0, character: 0 };

	const text = SOURCE_HEADER + pos.text;
	const line = pos.line + 1;
	const character = pos.character;

	// Present the hole's program as the crate root overlay.
	client.notify('textDocument/didOpen', {
		textDocument: { uri: evalLibUri, languageId: 'rust', version, text },
	});

	let result: any;
	let items: any[] = [];
	try {
		for (let attempt = 0; attempt < COMPLETION_ATTEMPTS; attempt++) {
			result = await client.request('textDocument/completion', {
				textDocument: { uri: evalLibUri },
				position: { line, character },
				context: { triggerKind: 1 },
			});
			items = Array.isArray(result) ? result : result?.items ?? [];
			if (items.length > 0) break;
			await delay(COMPLETION_RETRY_MS);
		}
	} catch (e: any) {
		client.notify('textDocument/didClose', { textDocument: { uri: evalLibUri } });
		return { error: e?.message ?? String(e), count: 0, items: [], line, character };
	}

	client.notify('textDocument/didClose', { textDocument: { uri: evalLibUri } });

	items = [...items].sort((a, b) => {
		const sa = a.sortText ?? a.label ?? '';
		const sb = b.sortText ?? b.label ?? '';
		return sa < sb ? -1 : sa > sb ? 1 : 0;
	});

	return { count: items.length, items, line, character };
}

// ---------------------------------------------------------------------------
// Run metadata
// ---------------------------------------------------------------------------

function evalCargoDependencies(): Record<string, string> {
	const deps: Record<string, string> = {};
	let toml: string;
	try { toml = fs.readFileSync(path.join(evalCargoDir, 'Cargo.toml'), 'utf8'); } catch { return deps; }

	let inDeps = false;
	for (const raw of toml.split('\n')) {
		const line = raw.trim();
		if (line.startsWith('[')) { inDeps = line === '[dependencies]'; continue; }
		if (!inDeps || !line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		deps[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
	}
	return deps;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface CatStats {
	total: number;
	exact: { any: number; k: Record<number, number> };
	errors: number;
	items: { sum: number; holes: number };
	rank: { sum: number; hits: number };
}
function newCatStats(): CatStats {
	return {
		total: 0,
		exact: { any: 0, k: Object.fromEntries(K_CUTOFFS.map((k) => [k, 0])) },
		errors: 0,
		items: { sum: 0, holes: 0 },
		rank: { sum: 0, hits: 0 },
	};
}

function buildTable(results: RaResult[]): { txt: string[]; md: string[] } {
	const byCat: Record<string, CatStats> = {};
	const total = newCatStats();

	const accumulate = (s: CatStats, r: RaResult) => {
		s.total++;
		if (r.error) s.errors++;
		else { s.items.sum += r.completion_count; s.items.holes++; }
		if (hitAny(r.exact_rank)) {
			s.exact.any++;
			s.rank.sum += (r.exact_rank as number) + 1;
			s.rank.hits++;
		}
		for (const k of K_CUTOFFS) {
			if (hitAtK(r.exact_rank, k)) s.exact.k[k]++;
		}
	};

	for (const r of results) {
		accumulate(total, r);
		for (const cat of categoriesOf(r.holeCategories)) {
			if (!byCat[cat]) byCat[cat] = newCatStats();
			accumulate(byCat[cat], r);
		}
	}

	const headers = ['category', 'exact@1', 'exact@5', 'exact@10', 'exact@any', 'avg_items', 'avg_rank', 'errors', 'total'];
	const rowFor = (name: string, s: CatStats): string[] => [
		name,
		frac(s.exact.k[1], s.total, 2),
		frac(s.exact.k[5], s.total, 2),
		frac(s.exact.k[10], s.total, 2),
		frac(s.exact.any, s.total, 2),
		avg(s.items.sum, s.items.holes),
		avg(s.rank.sum, s.rank.hits),
		frac(s.errors, s.total, 2),
		String(s.total),
	];

	const rows = Object.entries(byCat)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([cat, s]) => rowFor(cat, s));
	const totalRow = rowFor('TOTAL', total);

	const subtitle = `(hit@K = correct item within rust-analyzer's top-K; @any = anywhere in list; `
		+ `avg_items = mean list length over holes that returned one; `
		+ `avg_rank = mean 1-based rank of the correct item, over the exact@any holes only)`;
	const txt = [
		'\n=== rust-analyzer baseline: completion hit-rate by hole category ===',
		subtitle,
		...renderTextTable(headers, rows, totalRow),
	];
	const md = [
		'### rust-analyzer baseline: completion hit-rate by hole category',
		'',
		subtitle,
		'',
		...renderMarkdownTable(headers, rows, totalRow.map((c) => `**${c}**`)),
		'',
	];

	return { txt, md };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	if (RA_BIN.includes(path.sep) && !fs.existsSync(RA_BIN)) {
		console.error(`rust-analyzer binary not found at ${RA_BIN}. Set RA_BIN=/path/to/rust-analyzer.`);
		process.exit(1);
	}
	if (!fs.existsSync(generatedDir)) {
		console.error(`Dataset not found: ${generatedDir}`);
		process.exit(1);
	}

	const originalLib = fs.existsSync(evalLibPath) ? fs.readFileSync(evalLibPath, 'utf8') : '';
	let cases = collectTestCases(generatedDir);
	cases.sort((a, b) => `${a.task}/${a.hole}`.localeCompare(`${b.task}/${b.hole}`, undefined, { numeric: true }));
	if (Number.isFinite(limit)) cases = cases.slice(0, limit);

	console.log(`rust-analyzer: ${RA_BIN}`);
	console.log(`Evaluating ${cases.length} holes in dataset "${dataset}"...`);

	const client = new LspClient(RA_BIN, evalCargoDir);

	const clientCapabilities = {
		textDocument: {
			completion: {
				// Term-search results are rendered as snippets, so rust-analyzer drops
				// them entirely unless the client advertises snippet support. See
				// stripSnippet() for how the placeholders are removed before matching.
				completionItem: { snippetSupport: true },
				contextSupport: true,
			},
		},
		window: { workDoneProgress: true },
	};
	const initializationOptions = {
		cargo: { buildScripts: { enable: true } },
		procMacro: { enable: true },
		checkOnSave: false,
		completion: {
			autoimport: { enable: true },
			// Term search is rust-analyzer's own type-directed expression synthesis
			termSearch: { enable: true, fuel: TERM_SEARCH_FUEL },
		},
	};

	const initResult = await client.request<any>('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(evalCargoDir).toString(),
		capabilities: clientCapabilities,
		initializationOptions,
	});
	client.notify('initialized', {});

	const raVersion = initResult?.serverInfo?.version ?? 'unknown';
	console.log(`rust-analyzer version: ${raVersion}`);
	console.log(`term search fuel: ${TERM_SEARCH_FUEL}`);

	console.log('Waiting for rust-analyzer to finish indexing the project...');
	await client.waitUntilIdle();
	console.log('Indexing settled. Running completions.\n');

	const results: RaResult[] = [];
	let version = 1;
	let done = 0;

	for (const tc of cases) {
		const rustCode = fs.readFileSync(tc.rsFile, 'utf8');
		const meta: TestCaseMeta = JSON.parse(fs.readFileSync(tc.jsonFile, 'utf8'));

		const { error, count, items } = await evalHoleWithRa(client, version++, rustCode, meta);

		let exact_rank: number | null = null;
		if (!error) {
			const original = meta.original.trim();
			exact_rank = bestRank(items, (insertion, label) => {
				return isExactMatch(insertion.trim(), original) || isExactMatch((label ?? '').trim(), original);
			});
		}

		results.push({
			task: tc.task,
			hole: tc.hole,
			holeCategories: metaCategories(meta),
			original: meta.original,
			expected_type: meta.type,
			error,
			completion_count: count,
			exact_rank,
			completions: recordCompletions(items, exact_rank),
		});

		done++;
		const tag = error ? `ERROR (${error})` : `items:${count} exact@${exact_rank ?? '-'}`;
		process.stdout.write(`[${done}/${cases.length}] ${tc.task}/${tc.hole}: ${tag}\n`);
	}

	client.shutdown();
	// Restore the scratch lib so the tool's evaluator is unaffected.
	fs.writeFileSync(evalLibPath, originalLib, 'utf8');

	const runMeta = {
		generated_at: new Date().toISOString(),
		rust_analyzer: {
			version: raVersion,
			binary: RA_BIN,
		},
		dataset,
		holes_evaluated: results.length,
		limit: Number.isFinite(limit) ? limit : null,
		workspace: {
			cargo_dir: evalCargoDir,
			dependencies: evalCargoDependencies(),
		},
		initialization_options: initializationOptions,
		client_capabilities: clientCapabilities,
		completion_request: {
			trigger_kind: 1,
			attempts: COMPLETION_ATTEMPTS,
			retry_delay_ms: COMPLETION_RETRY_MS,
			source_header: SOURCE_HEADER,
			ranked_by: 'sortText',
		},
		recorded_completions: {
			max_per_hole: Number.isFinite(MAX_RECORDED_ITEMS) ? MAX_RECORDED_ITEMS : null,
			note: 'first N items in display order, plus the matched item when it ranks past N',
		},
		scoring: {
			k_cutoffs: K_CUTOFFS,
			match_rule: 'literal equality, or call shape (arguments stripped)',
		},
	};

	const jsonPath = path.join(generatedDir, 'ra_eval_results.json');
	fs.writeFileSync(jsonPath, JSON.stringify({ meta: runMeta, results }, null, 2));

	const { txt, md } = buildTable(results);
	for (const line of txt) console.log(line);

	const tablePath = path.join(generatedDir, 'ra_eval_table.txt');
	fs.writeFileSync(tablePath, txt.join('\n') + '\n');

	const mdPath = path.join(generatedDir, 'ra_eval_table.md');
	fs.writeFileSync(mdPath, md.join('\n') + '\n');

	console.log(`\nResults written to ${jsonPath}`);
	console.log(`Table written to ${tablePath}`);
	console.log(`Markdown table written to ${mdPath}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
