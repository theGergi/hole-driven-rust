import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import TypeChecker from './TypeChecker';
import { Hole } from '../../shared/out/types.js';
import { ParseTreeWalker } from 'antlr4ng';
import { UsageGraphListener } from './UsageListener';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { integer } from 'vscode-languageserver';
import { parseStdJsonFile } from './stdParser';

type EvalCategory = 'failed_with_error' | 'found_type' | 'found_suggestions' | 'exact_match' | 'failed';

interface TestCaseMeta {
	line: number;
	column_start: number;
	column_end: number;
	original: string;
	categories: string[];
	imports: string[];
}

interface SuggestionCompileResult {
	name: string;
	compiles: boolean;
}

interface EvalResult {
	task: string;
	hole: string;
	category: EvalCategory;
	holeCategories: string[];
	error?: string;
	suggestion_count?: number;
	suggestion_compile_results?: SuggestionCompileResult[];
	suggestions_with_holes?: string[];
}

const evalCargoDir = path.resolve(process.cwd(), 'server', 'eval_cargo');
const evalLibPath = path.join(evalCargoDir, 'src', 'lib.rs');

const stdParseResult = parseStdJsonFile();

function parseDocument(code: string): Hole[] {
	const inputStream = CharStream.fromString(code);
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);
	const parser = new RustParser(tokenStream);
	const tree = parser.crate();
	const listener = new UsageGraphListener();
	ParseTreeWalker.DEFAULT.walk(listener, tree);
	const interpreter = new TypeChecker(listener, stdParseResult) as any;
	interpreter.visit(tree);
	return interpreter.holes;
}

function checkCompiles(rustCode: string, suggestionName: string): boolean {
	const filled = rustCode.replace('??', suggestionName);
	// Suppress all warnings so only true errors fail the check
	const source = `#![allow(warnings)]\n${filled}`;

	fs.writeFileSync(evalLibPath, source, 'utf8');
	try {
		execSync(`cargo check --quiet --manifest-path ${evalCargoDir}/Cargo.toml 2>&1`, { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

function evaluateHole(
	rustCode: string,
	meta: TestCaseMeta
): { category: EvalCategory; error?: string; suggestions?: string[] } {
	let holes: Hole[];
	try {
		holes = parseDocument(rustCode);
	} catch (e: any) {
		return { category: 'failed_with_error', error: e?.message ?? String(e) };
	}

	const hole = holes.find(h => h.location.line === meta.line);
	if (!hole) {
		return {
			category: 'failed_with_error',
			error: `No hole found at line ${meta.line}. Found holes at lines: ${holes.map(h => h.location.line).join(', ')}`
		};
	}

	const typeKnown = hole.type && hole.type.valType !== 'HOLE' && hole.type.valType !== 'UNKNOWN';
	const hasSuggestions = hole.suggestions && hole.suggestions.length > 0;
	const exactMatch = hasSuggestions && hole.suggestions.some(s => s.suggestionNameNoParams === meta.original);

	const suggestionNames = hasSuggestions
		? hole.suggestions.map((s: any) => s.suggestionNameNoParams as string).filter(Boolean)
		: [];

	if (exactMatch) return { category: 'exact_match', suggestions: suggestionNames };
	if (hasSuggestions) return { category: 'found_suggestions', suggestions: suggestionNames };
	if (typeKnown) return { category: 'found_type' };
	return { category: 'failed', error: 'No type or suggestions found' };
}

function collectTestCases(dir: string): Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> {
	const cases: Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> = [];
	for (const taskEntry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!taskEntry.isDirectory()) continue;
		const taskDir = path.join(dir, taskEntry.name);
		for (const holeEntry of fs.readdirSync(taskDir, { withFileTypes: true })) {
			if (!holeEntry.isDirectory()) continue;
			const holeDir = path.join(taskDir, holeEntry.name);
			const files = fs.readdirSync(holeDir);
			const rsFile = files.find(f => f.endsWith('.rs'));
			const jsonFile = files.find(f => f.endsWith('.json'));
			if (rsFile && jsonFile) {
				cases.push({
					task: taskEntry.name,
					hole: holeEntry.name,
					rsFile: path.join(holeDir, rsFile),
					jsonFile: path.join(holeDir, jsonFile),
				});
			}
		}
	}
	return cases;
}

const compileSuggestions = process.argv.includes('--compile-suggestions');

const datasetArg = process.argv.find((arg) => arg.startsWith('--dataset='));
const dataset = datasetArg ? datasetArg.slice('--dataset='.length) : 'strategy1';

const generatedDir = path.resolve(process.cwd(), 'server', 'src', 'datasets', dataset);
const cases = collectTestCases(generatedDir);

const results: EvalResult[] = [];
const counts: Record<EvalCategory, number> = {
	failed_with_error: 0,
	found_type: 0,
	found_suggestions: 0,
	exact_match: 0,
	failed: 0,
};
let totalSuggestionsTested = 0;
let totalSuggestionsCompile = 0;
let totalSuggestionsWithHoles = 0;

// Suppress console output from the tool during evaluation
const origLog = console.log;
console.log = () => {};

for (const tc of cases) {
	const rustCode = fs.readFileSync(tc.rsFile, 'utf8');
	const meta: TestCaseMeta = JSON.parse(fs.readFileSync(tc.jsonFile, 'utf8'));
	const { category, error, suggestions } = evaluateHole(rustCode, meta);

	let suggestion_count: number | undefined;
	let suggestion_compile_results: SuggestionCompileResult[] | undefined;
	let suggestions_with_holes: string[] | undefined;

	if (suggestions && suggestions.length > 0) {
		suggestion_count = suggestions.length;

		suggestions_with_holes = suggestions.filter(name => name.includes('??'));
		if (suggestions_with_holes.length === 0) suggestions_with_holes = undefined;
		else totalSuggestionsWithHoles += suggestions_with_holes.length;

		if (compileSuggestions) {
			const compilable = suggestions.filter(name => !name.includes('??'));
			if (compilable.length > 0) {
				suggestion_compile_results = compilable.map(name => {
					const compiles = checkCompiles(rustCode, name);
					totalSuggestionsTested++;
					if (compiles) totalSuggestionsCompile++;
					return { name, compiles };
				});
			}
		}
	}

	results.push({
		task: tc.task,
		hole: tc.hole,
		category,
		holeCategories: meta.categories,
		error,
		suggestion_count,
		suggestion_compile_results,
		suggestions_with_holes,
	});
	counts[category]++;
}

console.log = origLog;

// Print per-result summary
for (const r of results) {
	const suffix = r.error ? ` — ${r.error}` : '';
	const parts: string[] = [];
	if (r.suggestion_count !== undefined) parts.push(`suggestions: ${r.suggestion_count}`);
	if (r.suggestion_compile_results) {
		const passing = r.suggestion_compile_results.filter(s => s.compiles).map(s => s.name);
		const failing = r.suggestion_compile_results.filter(s => !s.compiles).map(s => s.name);
		if (passing.length) parts.push(`compiles: [${passing.join(', ')}]`);
		if (failing.length) parts.push(`no-compile: [${failing.join(', ')}]`);
	}
	if (r.suggestions_with_holes) parts.push(`with-holes: [${r.suggestions_with_holes.join(', ')}]`);
	const compileSuffix = parts.length ? ' | ' + parts.join(' | ') : '';
	console.log(`${r.task}/${r.hole}: ${r.category}${suffix}${compileSuffix}`);
}

// Print aggregate counts
console.log('\n=== Summary ===');
console.log(`Total holes:             ${results.length}`);
console.log(`exact_match:             ${counts.exact_match}`);
console.log(`found_suggestions:       ${counts.found_suggestions}`);
console.log(`found_type:              ${counts.found_type}`);
console.log(`failed_with_error:       ${counts.failed_with_error}`);
console.log(`failed:       ${counts.failed}`);
console.log(`\nSuggestions with holes:  ${totalSuggestionsWithHoles}`);
if (compileSuggestions) {
	console.log(`Suggestions tested:      ${totalSuggestionsTested}`);
	console.log(`Suggestions compile:     ${totalSuggestionsCompile}`);
	if (totalSuggestionsTested > 0) {
		const pct = ((totalSuggestionsCompile / totalSuggestionsTested) * 100).toFixed(1);
		console.log(`Compile rate:            ${pct}%`);
	}
} else {
	console.log(`\n(Run with --compile-suggestions to check suggestion compilation)`);
}

// Print per-category table
const categoryTable: Record<string, Record<EvalCategory, number>> = {};
for (const r of results) {
	const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
	for (const cat of cats) {
		if (!categoryTable[cat]) {
			categoryTable[cat] = { failed_with_error: 0, failed: 0, found_type: 0, found_suggestions: 0, exact_match: 0 };
		}
		categoryTable[cat][r.category]++;
	}
}

const evalCats: EvalCategory[] = ['exact_match', 'found_suggestions', 'found_type', 'failed', 'failed_with_error'];
const colHeaders = ['category', 'exact', 'suggestions', 'type', 'failed', 'failed_with_error', 'total'];
const rows: string[][] = Object.entries(categoryTable)
.sort(([a], [b]) => a.localeCompare(b))
.map(([cat, c]) => {
		const total = evalCats.reduce((s, k) => s + c[k], 0);
		const stringify = (x: integer) => `${x} (${((x / total) * 100).toFixed(2)}%)`
		return [cat, stringify(c.exact_match), stringify(c.found_suggestions), stringify(c.found_type), stringify(c.failed), stringify(c.failed_with_error), String(total)];
	});

const colWidths = colHeaders.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(colWidths[i])).join('  ');
const sep = colWidths.map(w => '-'.repeat(w)).join('  ');

const tableLines = [
	'\n=== Results by Hole Category ===',
	fmt(colHeaders),
	sep,
	...rows.map(fmt),
];
for (const line of tableLines) console.log(line);

// Print per-category suggestion stats table
interface SuggestionCategoryStats {
	total: number;
	withHoles: number;
	tested: number;
	compiled: number;
}

const suggestionCategoryTable: Record<string, SuggestionCategoryStats> = {};
for (const r of results) {
	const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
	const total = r.suggestion_count ?? 0;
	const withHoles = r.suggestions_with_holes?.length ?? 0;
	const tested = r.suggestion_compile_results?.length ?? 0;
	const compiled = r.suggestion_compile_results?.filter(s => s.compiles).length ?? 0;
	for (const cat of cats) {
		if (!suggestionCategoryTable[cat]) {
			suggestionCategoryTable[cat] = { total: 0, withHoles: 0, tested: 0, compiled: 0 };
		}
		suggestionCategoryTable[cat].total += total;
		suggestionCategoryTable[cat].withHoles += withHoles;
		suggestionCategoryTable[cat].tested += tested;
		suggestionCategoryTable[cat].compiled += compiled;
	}
}

const suggestionColHeaders = ['category', 'total_suggestions', 'suggestions_with_holes', 'suggestions_tested', 'suggestions_compiled'];
const suggestionRows: string[][] = Object.entries(suggestionCategoryTable)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([cat, s]) => {
		const pctOfTotal = (x: integer) => s.total > 0 ? `${x} (${((x / s.total) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		const pctOfTested = (x: integer) => s.tested > 0 ? `${x} (${((x / s.tested) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		return [cat, String(s.total), pctOfTotal(s.withHoles), pctOfTotal(s.tested), pctOfTested(s.compiled)];
	});

const suggestionColWidths = suggestionColHeaders.map((h, i) => Math.max(h.length, ...suggestionRows.map(r => r[i].length)));
const suggestionFmt = (row: string[]) => row.map((cell, i) => cell.padEnd(suggestionColWidths[i])).join('  ');
const suggestionSep = suggestionColWidths.map(w => '-'.repeat(w)).join('  ');

const suggestionTableLines = [
	'\n=== Suggestion Stats by Hole Category ===',
	...(compileSuggestions ? [] : ['(Run with --compile-suggestions to populate suggestions_tested/suggestions_compiled)']),
	suggestionFmt(suggestionColHeaders),
	suggestionSep,
	...suggestionRows.map(suggestionFmt),
];
for (const line of suggestionTableLines) console.log(line);

// Write results to evaluations folder
// const evaluationsDir = path.resolve(process.cwd(), 'server', 'evaluations');
// fs.mkdirSync(evaluationsDir, { recursive: true });

const jsonPath = path.join(generatedDir, 'eval_results.json');
fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
console.log(`\nResults written to ${jsonPath}`);

const tablePath = path.join(generatedDir, 'eval_table.txt');
fs.writeFileSync(tablePath, tableLines.join('\n') + '\n');
console.log(`Table written to ${tablePath}`);

const suggestionTablePath = path.join(generatedDir, 'eval_suggestion_table.txt');
fs.writeFileSync(suggestionTablePath, suggestionTableLines.join('\n') + '\n');
console.log(`Suggestion table written to ${suggestionTablePath}`);
