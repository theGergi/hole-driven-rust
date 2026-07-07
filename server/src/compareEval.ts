import * as fs from 'fs';
import * as path from 'path';
import {
	resolveDataset,
	frac,
	hitAtK,
	hitAny,
	categoriesOf,
	renderTextTable,
	renderMarkdownTable,
} from './evalShared';

interface ToolResult {
	task: string;
	hole: string;
	holeCategories: string[];
	exact_match_rank?: number | null;
}
interface RaResult {
	task: string;
	hole: string;
	holeCategories: string[];
	exact_rank: number | null;
}

const K = 5;

const { dataset, datasetDir: dir } = resolveDataset('assignments_no_types');

const toolPath = path.join(dir, 'eval_results.json');
const raPath = path.join(dir, 'ra_eval_results.json');
for (const p of [toolPath, raPath]) {
	if (!fs.existsSync(p)) {
		console.error(`Missing ${p}. Run the corresponding evaluator first.`);
		process.exit(1);
	}
}

const toolResults: ToolResult[] = JSON.parse(fs.readFileSync(toolPath, 'utf8'));
const raResults: RaResult[] = JSON.parse(fs.readFileSync(raPath, 'utf8'));

const key = (r: { task: string; hole: string }) => `${r.task}/${r.hole}`;
const raByKey = new Map(raResults.map((r) => [key(r), r]));

interface Stats {
	total: number;
	toolAny: number;
	toolK: number;
	raK: number;
	raAny: number;
}
const newStats = (): Stats => ({ total: 0, toolAny: 0, toolK: 0, raK: 0, raAny: 0 });

const byCat: Record<string, Stats> = {};
const totals = newStats();

let missingRa = 0;
for (const t of toolResults) {
	const ra = raByKey.get(key(t));
	if (!ra) { missingRa++; continue; }

	const accumulate = (s: Stats) => {
		s.total++;
		if (hitAny(t.exact_match_rank)) s.toolAny++;
		if (hitAtK(t.exact_match_rank, K)) s.toolK++;
		if (hitAtK(ra.exact_rank, K)) s.raK++;
		if (hitAny(ra.exact_rank)) s.raAny++;
	};

	accumulate(totals);
	for (const cat of categoriesOf(t.holeCategories)) {
		if (!byCat[cat]) byCat[cat] = newStats();
		accumulate(byCat[cat]);
	}
}
if (missingRa > 0) console.error(`Warning: ${missingRa} tool holes had no rust-analyzer counterpart.`);

const pct = (x: number, total: number) => frac(x, total, 1);
const rate = (x: number, total: number) => (total > 0 ? x / total : 0);

// Columns are grouped so the two like-for-like comparisons sit side by side:
// the top-5 pair (Tool exact_match@5 vs RA exact@5) and the anywhere pair
// (Tool exact_match vs RA exact@any). The higher rate in each pair is the winner.
const headers = [
	'category',
	`Tool exact_match@${K}`,
	`RA exact@${K}`,
	'Tool exact_match',
	'RA exact@any',
	'total',
];

function markPair(
	aStr: string, aVal: number,
	bStr: string, bVal: number,
	style: 'md' | 'txt'
): [string, string] {
	const win = (s: string) => (style === 'md' ? `**${s}**` : `${s} *`);
	if (aVal > bVal) return [win(aStr), bStr];
	if (bVal > aVal) return [aStr, win(bStr)];
	return [aStr, bStr];
}

function rowFor(name: string, s: Stats, style: 'md' | 'txt'): string[] {
	const [tool5, ra5] = markPair(
		pct(s.toolK, s.total), rate(s.toolK, s.total),
		pct(s.raK, s.total), rate(s.raK, s.total),
		style
	);
	const [toolAny, raAny] = markPair(
		pct(s.toolAny, s.total), rate(s.toolAny, s.total),
		pct(s.raAny, s.total), rate(s.raAny, s.total),
		style
	);
	const label = style === 'md' && name === 'TOTAL' ? '**TOTAL**' : name;
	return [label, tool5, ra5, toolAny, raAny, String(s.total)];
}

const sortedCats = Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b));

// --- aligned plain-text table (winner marked with *) ---
const txtRows = sortedCats.map(([cat, s]) => rowFor(cat, s, 'txt'));
const txtTotalRow = rowFor('TOTAL', totals, 'txt');
const txtLines = [
	`=== Tool vs rust-analyzer: exact-match comparison by hole category (dataset "${dataset}") ===`,
	`(each pair's winner marked with *; @5 = within top 5, exact_match/any = anywhere in list)`,
	...renderTextTable(headers, txtRows, txtTotalRow),
];
for (const l of txtLines) console.log(l);

// --- markdown table (winner bolded; handy for the thesis) ---
const mdRows = sortedCats.map(([cat, s]) => rowFor(cat, s, 'md'));
const mdTotalRow = rowFor('TOTAL', totals, 'md');
const mdLines = renderMarkdownTable(headers, mdRows, mdTotalRow);

const txtPath = path.join(dir, 'comparison_table.txt');
const mdPath = path.join(dir, 'comparison_table.md');
fs.writeFileSync(txtPath, txtLines.join('\n') + '\n');
fs.writeFileSync(mdPath, mdLines.join('\n') + '\n');
console.log(`\nWritten:\n  ${txtPath}\n  ${mdPath}`);
