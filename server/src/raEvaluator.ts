import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * rust-analyzer baseline evaluator.
 *
 * For every hole in a dataset we ask rust-analyzer for the completions it would
 * offer at the hole position and compare them against the ground-truth
 * expression (`original` in the hole metadata). This is the rust-analyzer
 * counterpart to `evaluator.ts`, so the two can be compared on the same holes.
 *
 * rust-analyzer only ever completes a single token at the cursor (an in-scope
 * identifier, a method after `.`, a field, ...), whereas `original` may be a
 * whole expression such as `distance.abs()`. We record an exact-match per hole:
 * some completion inserts the full `original` verbatim.
 *
 * rust-analyzer returns a large, sorted list (in-scope names + stdlib), so we
 * store the rank (0-indexed, in sortText display order) of the best matching
 * item and later report hit@1 / hit@5 / hit@10 / hit@any.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_RA_BIN = path.join(
	os.homedir(),
	'.vscode/extensions/rust-lang.rust-analyzer-0.3.2955-linux-x64/server/rust-analyzer'
);
const RA_BIN = process.env.RA_BIN || DEFAULT_RA_BIN;

// K cutoffs reported in the summary tables.
const K_CUTOFFS = [1, 5, 10];

// The scratch cargo project rust-analyzer analyses. We reuse the same one the
// tool's evaluator compiles against so the dependency set (rand/regex/md5) and
// stdlib resolution match.
const evalCargoDir = path.resolve(process.cwd(), 'server', 'eval_cargo');
const evalLibPath = path.join(evalCargoDir, 'src', 'lib.rs');
const evalLibUri = pathToFileURL(evalLibPath).toString();

const datasetArg = process.argv.find((arg) => arg.startsWith('--dataset='));
const dataset = datasetArg ? datasetArg.slice('--dataset='.length) : 'assignments_no_types';

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : Infinity;

const generatedDir = path.resolve(process.cwd(), 'server', 'src', 'datasets', dataset);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestCaseMeta {
	line: number;
	column_start: number;
	column_end: number;
	original: string;
	categories: string[];
	imports: string[];
	type?: string;
}

interface RaResult {
	task: string;
	hole: string;
	holeCategories: string[];
	original: string;
	expected_type?: string;
	error?: string;
	completion_count: number;
	// 0-indexed rank in sortText display order, or null if no match.
	exact_rank: number | null;
}

// ---------------------------------------------------------------------------
// Minimal stdio LSP client (Content-Length framed JSON-RPC)
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

	/** Resolve once no `$/progress` has arrived for `quietMs`, or after `capMs`. */
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
// Dataset walking (same shape as evaluator.ts collectTestCases)
// ---------------------------------------------------------------------------

function collectTestCases(
	dir: string,
	rootDir: string = dir
): Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> {
	const cases: Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = entries.filter((e) => e.isFile()).map((e) => e.name);
	const rsFile = files.find((f) => f.endsWith('.rs'));
	const jsonFile = files.find((f) => f.endsWith('.json'));

	if (rsFile && jsonFile) {
		cases.push({
			task: path.relative(rootDir, path.dirname(dir)) || path.basename(dir),
			hole: path.basename(dir),
			rsFile: path.join(dir, rsFile),
			jsonFile: path.join(dir, jsonFile),
		});
	}
	for (const entry of entries) {
		if (entry.isDirectory()) cases.push(...collectTestCases(path.join(dir, entry.name), rootDir));
	}
	return cases;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Text rust-analyzer would actually insert for a completion item. */
function insertionOf(item: any): string {
	if (typeof item.insertText === 'string') return item.insertText;
	if (item.textEdit && typeof item.textEdit.newText === 'string') return item.textEdit.newText;
	return item.label ?? '';
}

/**
 * Given rust-analyzer's items (sorted into display order) return the best
 * (lowest) rank at which `predicate` holds, or null.
 */
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

	// #![allow(warnings)] mirrors the tool's cargo-check setup and keeps the file
	// as a lib root; the leading line shifts positions by one, so add 1 to line.
	const header = '#![allow(warnings)]\n';
	const text = header + pos.text;
	const line = pos.line + 1;
	const character = pos.character;

	// Present the hole's program as the crate root overlay.
	client.notify('textDocument/didOpen', {
		textDocument: { uri: evalLibUri, languageId: 'rust', version, text },
	});

	let result: any;
	let items: any[] = [];
	try {
		// rust-analyzer computes completions from the current overlay; retry a few
		// times in case analysis of the just-opened document hasn't settled.
		for (let attempt = 0; attempt < 4; attempt++) {
			result = await client.request('textDocument/completion', {
				textDocument: { uri: evalLibUri },
				position: { line, character },
				context: { triggerKind: 1 },
			});
			items = Array.isArray(result) ? result : result?.items ?? [];
			if (items.length > 0) break;
			await delay(400);
		}
	} catch (e: any) {
		client.notify('textDocument/didClose', { textDocument: { uri: evalLibUri } });
		return { error: e?.message ?? String(e), count: 0, items: [], line, character };
	}

	client.notify('textDocument/didClose', { textDocument: { uri: evalLibUri } });

	// Display order is by sortText (falling back to label), which is what the
	// user sees in the completion popup.
	items = [...items].sort((a, b) => {
		const sa = a.sortText ?? a.label ?? '';
		const sb = b.sortText ?? b.label ?? '';
		return sa < sb ? -1 : sa > sb ? 1 : 0;
	});

	return { count: items.length, items, line, character };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const frac = (x: number, total: number) =>
	total > 0 ? `${x}/${total} (${((x / total) * 100).toFixed(2)}%)` : `${x}/${total} (0.00%)`;

function hitAtK(rank: number | null, k: number): boolean {
	return rank !== null && rank < k;
}
function hitAny(rank: number | null): boolean {
	return rank !== null;
}

interface CatStats {
	total: number;
	exact: { any: number; k: Record<number, number> };
	errors: number;
}
function newCatStats(): CatStats {
	return {
		total: 0,
		exact: { any: 0, k: Object.fromEntries(K_CUTOFFS.map((k) => [k, 0])) },
		errors: 0,
	};
}

function buildTable(results: RaResult[]): string[] {
	const byCat: Record<string, CatStats> = {};
	const total = newCatStats();

	const accumulate = (s: CatStats, r: RaResult) => {
		s.total++;
		if (r.error) s.errors++;
		if (hitAny(r.exact_rank)) s.exact.any++;
		for (const k of K_CUTOFFS) {
			if (hitAtK(r.exact_rank, k)) s.exact.k[k]++;
		}
	};

	for (const r of results) {
		accumulate(total, r);
		const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
		for (const cat of cats) {
			if (!byCat[cat]) byCat[cat] = newCatStats();
			accumulate(byCat[cat], r);
		}
	}

	const headers = [
		'category',
		'exact@1',
		'exact@5',
		'exact@10',
		'exact@any',
		'errors',
		'total',
	];
	const rowFor = (name: string, s: CatStats): string[] => [
		name,
		frac(s.exact.k[1], s.total),
		frac(s.exact.k[5], s.total),
		frac(s.exact.k[10], s.total),
		frac(s.exact.any, s.total),
		frac(s.errors, s.total),
		String(s.total),
	];

	const rows = Object.entries(byCat)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([cat, s]) => rowFor(cat, s));
	const totalRow = rowFor('TOTAL', total);

	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length), totalRow[i].length));
	const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
	const sep = widths.map((w) => '-'.repeat(w)).join('  ');

	return [
		'\n=== rust-analyzer baseline: completion hit-rate by hole category ===',
		`(hit@K = correct item within rust-analyzer's top-K; @any = anywhere in list)`,
		fmt(headers),
		sep,
		...rows.map(fmt),
		sep,
		fmt(totalRow),
	];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	if (!fs.existsSync(RA_BIN)) {
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

	await client.request('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(evalCargoDir).toString(),
		capabilities: {
			textDocument: {
				completion: {
					completionItem: { snippetSupport: false },
					contextSupport: true,
				},
			},
			window: { workDoneProgress: true },
		},
		initializationOptions: {
			cargo: { buildScripts: { enable: true } },
			procMacro: { enable: true },
			checkOnSave: false,
			completion: { autoimport: { enable: false } },
		},
	});
	client.notify('initialized', {});

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
				return insertion.trim() === original || (label ?? '').trim() === original;
			});
		}

		results.push({
			task: tc.task,
			hole: tc.hole,
			holeCategories: meta.categories,
			original: meta.original,
			expected_type: meta.type,
			error,
			completion_count: count,
			exact_rank,
		});

		done++;
		const tag = error ? `ERROR (${error})` : `items:${count} exact@${exact_rank ?? '-'}`;
		process.stdout.write(`[${done}/${cases.length}] ${tc.task}/${tc.hole}: ${tag}\n`);
	}

	client.shutdown();
	// Restore the scratch lib so the tool's evaluator is unaffected.
	fs.writeFileSync(evalLibPath, originalLib, 'utf8');

	const jsonPath = path.join(generatedDir, 'ra_eval_results.json');
	fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

	const tableLines = buildTable(results);
	for (const line of tableLines) console.log(line);

	const tablePath = path.join(generatedDir, 'ra_eval_table.txt');
	fs.writeFileSync(tablePath, tableLines.join('\n') + '\n');

	console.log(`\nResults written to ${jsonPath}`);
	console.log(`Table written to ${tablePath}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
