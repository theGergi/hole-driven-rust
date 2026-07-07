import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Test-case metadata + dataset walking
// ---------------------------------------------------------------------------

export interface TestCaseMeta {
	line: number;
	column_start: number;
	column_end: number;
	original: string;
	categories: string[];
	imports: string[];
	type?: string;
}

export interface TestCase {
	task: string;
	hole: string;
	rsFile: string;
	jsonFile: string;
}

/** Recursively collect every `(.rs, .json)` hole directory under `dir`. */
export function collectTestCases(dir: string, rootDir: string = dir): TestCase[] {
	const cases: TestCase[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = entries.filter(e => e.isFile()).map(e => e.name);
	const rsFile = files.find(f => f.endsWith('.rs'));
	const jsonFile = files.find(f => f.endsWith('.json'));

	if (rsFile && jsonFile) {
		cases.push({
			task: path.relative(rootDir, path.dirname(dir)) || path.basename(dir),
			hole: path.basename(dir),
			rsFile: path.join(dir, rsFile),
			jsonFile: path.join(dir, jsonFile),
		});
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			cases.push(...collectTestCases(path.join(dir, entry.name), rootDir));
		}
	}

	return cases;
}

// ---------------------------------------------------------------------------
// Argument parsing + shared paths
// ---------------------------------------------------------------------------

/** Resolve the `--dataset=` argument (falling back to `defaultDataset`) and its directory. */
export function resolveDataset(defaultDataset: string): { dataset: string; datasetDir: string } {
	const arg = process.argv.find(a => a.startsWith('--dataset='));
	const dataset = arg ? arg.slice('--dataset='.length) : defaultDataset;
	const datasetDir = path.resolve(process.cwd(), 'server', 'src', 'datasets', dataset);
	return { dataset, datasetDir };
}

export const evalCargoDir = path.resolve(process.cwd(), 'server', 'eval_cargo');
export const evalLibPath = path.join(evalCargoDir, 'src', 'lib.rs');

// ---------------------------------------------------------------------------
// Formatting + hit@K helpers
// ---------------------------------------------------------------------------

export function frac(x: number, total: number, digits = 1): string {
	const pct = total > 0 ? (x / total) * 100 : 0;
	return `${x}/${total} (${pct.toFixed(digits)}%)`;
}

export function hitAny(rank: number | null | undefined): boolean {
	return rank !== null && rank !== undefined;
}

export function hitAtK(rank: number | null | undefined, k: number): boolean {
	return hitAny(rank) && (rank as number) < k;
}

export function categoriesOf(holeCategories: string[]): string[] {
	return holeCategories.length > 0 ? holeCategories : ['(none)'];
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

export function renderTextTable(headers: string[], rows: string[][], totalRow: string[]): string[] {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map(r => r[i].length), totalRow[i].length));
	const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
	const sep = widths.map(w => '-'.repeat(w)).join('  ');
	return [fmt(headers), sep, ...rows.map(fmt), sep, fmt(totalRow)];
}

export function renderMarkdownTable(headers: string[], rows: string[][], totalRow: string[]): string[] {
	const mdRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
	return [mdRow(headers), mdRow(headers.map(() => '---')), ...rows.map(mdRow), mdRow(totalRow)];
}
