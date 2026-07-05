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

// Cap on how many suggestions get compiled per hole when --compile-suggestions is set,
// since compiling every suggestion can be prohibitively slow.
const MAX_SUGGESTIONS_TO_COMPILE = 5;

type EvalCategory = 'failed_with_error' | 'found_type' | 'found_suggestions' | 'exact_match' | 'failed';

interface TestCaseMeta {
	line: number;
	column_start: number;
	column_end: number;
	original: string;
	categories: string[];
	imports: string[];
	type?: string;
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
	any_suggestion_compiles?: boolean;
	suggestions_with_holes?: string[];
	hole_type?: string;
	hole_type_compiles?: boolean;
	hole_type_compile_error?: string;
	expected_type?: string;
	matched_type?: boolean;
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

function runCargoCheck(rustCode: string, replacement: string): { compiles: boolean; error?: string } {
	const filled = rustCode.replace('??', replacement);
	// Suppress all warnings so only true errors fail the check
	const source = `#![allow(warnings)]\n${filled}`;

	fs.writeFileSync(evalLibPath, source, 'utf8');
	try {
		execSync(`cargo check --quiet --manifest-path ${evalCargoDir}/Cargo.toml 2>&1`, { stdio: 'pipe' });
		return { compiles: true };
	} catch (e: any) {
		const error = e?.stdout?.toString() ?? e?.message ?? String(e);
		return { compiles: false, error };
	}
}

function checkCompiles(rustCode: string, replacement: string): boolean {
	return runCargoCheck(rustCode, replacement).compiles;
}

function checkHoleTypeCompiles(rustCode: string, holeType: string): { compiles: boolean; error?: string } {
	return runCargoCheck(rustCode, `{ let temp: ${holeType} = todo!(); temp }`);
}

function normalizeType(type: string): string {
	// Strip module-path qualifiers (e.g. `std::vec::Vec` -> `Vec`, `std::string::String` -> `String`)
	// so semantically identical types written with different path qualification still compare equal.
	const stripped = type.replace(/(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
	return stripped
			.replace(/\s+/g, '')
			.replace(/\b(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize)\b/g, 'int') // HACKY, cause we don't handle different types well now
			.replace(/\b(f32|f64)\b/g, 'float')
			.replace(/<[^>]*>/g, ""); // TODO: Maybe this is too weak
}

function typesMatch(foundType: string, expectedType: string, holeSupTypes?: string[]): boolean {
	
	// if (foundType === 'trait') {
		// 	console.log("Checking trait")
		// 	console.log(expectedType)
		// 	console.log(holeSupTypes)
		// 	console.log(normalizeType('std::ops::Range<i32>') === normalizeType('Range<i32>'))
		// }

	if (holeSupTypes) {
		return holeSupTypes.some(st => normalizeType(st) === normalizeType(expectedType))
	}
	
	if (normalizeType(foundType) !== normalizeType(expectedType)) {
		console.log(`Type mismatch: found "${normalizeType(foundType)}", expected "${normalizeType(expectedType)}"`);
	}

	return normalizeType(foundType) === normalizeType(expectedType);
}

function evaluateHole(
	rustCode: string,
	meta: TestCaseMeta
): { category: EvalCategory; error?: string; suggestions?: string[]; holeType?: string, holeSubTypes?: string[] } {
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
	const holeType = typeKnown ? hole.type.toTypeString() : undefined;
	const holeSubTypes = typeKnown && hole.subTypes ? hole.subTypes.map(st => st.toTypeString()) : undefined;
	const hasSuggestions = hole.suggestions && hole.suggestions.length > 0;
	const exactMatch = hasSuggestions && hole.suggestions.some(s => s.suggestionNameNoParams === meta.original);

	const suggestionNames = hasSuggestions
		? hole.suggestions.map((s: any) => s.suggestionNameNoParams as string).filter(Boolean)
		: [];

	if (exactMatch) return { category: 'exact_match', suggestions: suggestionNames, holeType, holeSubTypes };
	if (hasSuggestions) return { category: 'found_suggestions', suggestions: suggestionNames, holeType, holeSubTypes };
	if (typeKnown) return { category: 'found_type', holeType, holeSubTypes };
	return { category: 'failed', error: 'No type or suggestions found' };
}

function collectTestCases(dir: string, rootDir: string = dir): Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> {
	const cases: Array<{ task: string; hole: string; rsFile: string; jsonFile: string }> = [];
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

const compileSuggestions = process.argv.includes('--compile-suggestions');
const compileTypes = process.argv.includes('--compile-types');

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
let totalHolesWithSuggestionsTested = 0;
let totalHolesWithValidSuggestion = 0;
let totalSuggestionsWithHoles = 0;
let totalHoleTypesTested = 0;
let totalHoleTypesCompile = 0;
let totalTypesTested = 0;
let totalTypesMatched = 0;

console.log(`Evaluating ${cases.length} test cases in dataset "${dataset}"...`);

// Suppress console output from the tool during evaluation
const origLog = console.log;
console.log = () => {};

for (const tc of cases) {
	const rustCode = fs.readFileSync(tc.rsFile, 'utf8');
	const meta: TestCaseMeta = JSON.parse(fs.readFileSync(tc.jsonFile, 'utf8'));
	const { category, error, suggestions, holeType, holeSubTypes } = evaluateHole(rustCode, meta);

	let suggestion_count: number | undefined;
	let suggestion_compile_results: SuggestionCompileResult[] | undefined;
	let any_suggestion_compiles: boolean | undefined;
	let suggestions_with_holes: string[] | undefined;
	let hole_type_compiles: boolean | undefined;
	let hole_type_compile_error: string | undefined;

	if (suggestions && suggestions.length > 0) {
		suggestion_count = suggestions.length;

		suggestions_with_holes = suggestions.filter(name => name.includes('??'));
		if (suggestions_with_holes.length === 0) suggestions_with_holes = undefined;
		else totalSuggestionsWithHoles += suggestions_with_holes.length;

		if (compileSuggestions) {
			const compilable = suggestions.filter(name => !name.includes('??')).slice(0, MAX_SUGGESTIONS_TO_COMPILE);
			if (compilable.length > 0) {
				suggestion_compile_results = compilable.map(name => {
					const compiles = checkCompiles(rustCode, name);
					return { name, compiles };
				});
				any_suggestion_compiles = suggestion_compile_results.some(s => s.compiles);
				totalHolesWithSuggestionsTested++;
				if (any_suggestion_compiles) totalHolesWithValidSuggestion++;
			}
		}
	}

	if (compileTypes && holeType) {
		const holeTypeResult = checkHoleTypeCompiles(rustCode, holeType);
		hole_type_compiles = holeTypeResult.compiles;
		hole_type_compile_error = holeTypeResult.error;
		totalHoleTypesTested++;
		if (hole_type_compiles) totalHoleTypesCompile++;
	}

	let matched_type: boolean | undefined;
	if (meta.type && holeType) {
		console.log = origLog;
		matched_type = typesMatch(holeType, meta.type, holeSubTypes);
		console.log = () => {};
		totalTypesTested++;
		if (matched_type) totalTypesMatched++;
	}

	results.push({
		task: tc.task,
		hole: tc.hole,
		category,
		holeCategories: meta.categories,
		error,
		suggestion_count,
		suggestion_compile_results,
		any_suggestion_compiles,
		suggestions_with_holes,
		hole_type: holeType,
		hole_type_compiles,
		hole_type_compile_error,
		expected_type: meta.type,
		matched_type,
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
	if (r.hole_type) parts.push(`hole_type: ${r.hole_type}${r.hole_type_compiles !== undefined ? (r.hole_type_compiles ? ' (compiles)' : ' (no-compile)') : ''}`);
	if (r.expected_type) parts.push(`expected_type: ${r.expected_type}${r.matched_type !== undefined ? (r.matched_type ? ' (matched)' : ' (mismatch)') : ''}`);
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

console.log("Compiling suggestions...")
if (compileSuggestions) {
	console.log(`Holes with suggestions tested: ${totalHolesWithSuggestionsTested}`);
	console.log(`Holes with a valid suggestion: ${totalHolesWithValidSuggestion}`);
	if (totalHolesWithSuggestionsTested > 0) {
		const pct = ((totalHolesWithValidSuggestion / totalHolesWithSuggestionsTested) * 100).toFixed(1);
		console.log(`Valid-suggestion rate:         ${pct}%`);
	}
} else {
	console.log(`\n(Run with --compile-suggestions to check suggestion compilation)`);
}

console.log("Compiling types...")
if (compileTypes) {
	console.log(`\nHole types tested:       ${totalHoleTypesTested}`);
	console.log(`Hole types compile:      ${totalHoleTypesCompile}`);
	if (totalHoleTypesTested > 0) {
		const pct = ((totalHoleTypesCompile / totalHoleTypesTested) * 100).toFixed(1);
		console.log(`Hole type compile rate:  ${pct}%`);
	}
} else {
	console.log(`\n(Run with --compile-types to check hole type compilation)`);
}

console.log(`\nTypes tested against expected: ${totalTypesTested}`);
console.log(`Types matched:                 ${totalTypesMatched}`);
if (totalTypesTested > 0) {
	const pct = ((totalTypesMatched / totalTypesTested) * 100).toFixed(1);
	console.log(`Match rate:                    ${pct}%`);
}

// Per-category matched-type stats (computed here so it can feed the main results table below)
interface MatchedTypeCategoryStats {
	tested: number;
	matched: number;
}

const matchedTypeCategoryTable: Record<string, MatchedTypeCategoryStats> = {};
for (const r of results) {
	const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
	const tested = r.matched_type !== undefined ? 1 : 0;
	const matched = r.matched_type ? 1 : 0;
	for (const cat of cats) {
		if (!matchedTypeCategoryTable[cat]) {
			matchedTypeCategoryTable[cat] = { tested: 0, matched: 0 };
		}
		matchedTypeCategoryTable[cat].tested += tested;
		matchedTypeCategoryTable[cat].matched += matched;
	}
}
// Generic "number/total (percent)" formatter used across the main results table
const frac = (x: integer, total: integer) =>
	total > 0 ? `${x}/${total} (${((x / total) * 100).toFixed(2)}%)` : `${x}/${total} (0.00%)`;

// Per-category hole-type compile stats (computed here so it can feed the main results table below)
interface HoleTypeCategoryStats {
	tested: number;
	compiled: number;
}

const holeTypeCategoryTable: Record<string, HoleTypeCategoryStats> = {};
for (const r of results) {
	const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
	const tested = r.hole_type_compiles !== undefined ? 1 : 0;
	const compiled = r.hole_type_compiles ? 1 : 0;
	for (const cat of cats) {
		if (!holeTypeCategoryTable[cat]) {
			holeTypeCategoryTable[cat] = { tested: 0, compiled: 0 };
		}
		holeTypeCategoryTable[cat].tested += tested;
		holeTypeCategoryTable[cat].compiled += compiled;
	}
}
// Per-category suggestion compile stats (computed here so it can feed the main results table below)
interface SuggestionCategoryStats {
	total: number;
	withHoles: number;
	tested: number;
	compiled: number;
	holesTested: number;
	holesWithValid: number;
}

const suggestionCategoryTable: Record<string, SuggestionCategoryStats> = {};
for (const r of results) {
	const cats = r.holeCategories.length > 0 ? r.holeCategories : ['(none)'];
	const total = r.suggestion_count ?? 0;
	const withHoles = r.suggestions_with_holes?.length ?? 0;
	const tested = r.suggestion_compile_results?.length ?? 0;
	const compiled = r.suggestion_compile_results?.filter(s => s.compiles).length ?? 0;
	const holesTested = r.suggestion_compile_results ? 1 : 0;
	const holesWithValid = r.any_suggestion_compiles ? 1 : 0;
	for (const cat of cats) {
		if (!suggestionCategoryTable[cat]) {
			suggestionCategoryTable[cat] = { total: 0, withHoles: 0, tested: 0, compiled: 0, holesTested: 0, holesWithValid: 0 };
		}
		suggestionCategoryTable[cat].total += total;
		suggestionCategoryTable[cat].withHoles += withHoles;
		suggestionCategoryTable[cat].tested += tested;
		suggestionCategoryTable[cat].compiled += compiled;
		suggestionCategoryTable[cat].holesTested += holesTested;
		suggestionCategoryTable[cat].holesWithValid += holesWithValid;
	}
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
const colHeaders = ['category', 'exact_match', 'matched_type', 'valid_suggestion', 'compiled_type', 'failed', 'failed_with_error', 'total'];
const rows: string[][] = Object.entries(categoryTable)
.sort(([a], [b]) => a.localeCompare(b))
.map(([cat, c]) => {
		const total = evalCats.reduce((s, k) => s + c[k], 0);
		const matchedTypeStats = matchedTypeCategoryTable[cat] ?? { tested: 0, matched: 0 };
		const suggestionStats = suggestionCategoryTable[cat] ?? { total: 0, withHoles: 0, tested: 0, compiled: 0, holesTested: 0, holesWithValid: 0 };
		const holeTypeStats = holeTypeCategoryTable[cat] ?? { tested: 0, compiled: 0 };
		return [
			cat,
			frac(c.exact_match, total),
			frac(matchedTypeStats.matched, total),
			frac(suggestionStats.holesWithValid, total),
			frac(holeTypeStats.compiled, total),
			frac(c.failed, total),
			frac(c.failed_with_error, total),
			String(total),
		];
	});

const grandTotal = results.length;
const totalRow = [
	'TOTAL',
	frac(counts.exact_match, grandTotal),
	frac(totalTypesMatched, grandTotal),
	frac(totalHolesWithValidSuggestion, grandTotal),
	frac(totalHoleTypesCompile, grandTotal),
	frac(counts.failed, grandTotal),
	frac(counts.failed_with_error, grandTotal),
	String(grandTotal),
];

const colWidths = colHeaders.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length), totalRow[i].length));
const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(colWidths[i])).join('  ');
const sep = colWidths.map(w => '-'.repeat(w)).join('  ');

const tableLines = [
	'\n=== Results by Hole Category ===',
	fmt(colHeaders),
	sep,
	...rows.map(fmt),
	sep,
	fmt(totalRow),
];
for (const line of tableLines) console.log(line);

// Print per-category suggestion stats table
const suggestionColHeaders = ['category', 'total_suggestions', 'suggestions_with_holes', 'suggestions_tested', 'suggestions_compiled', 'holes_with_valid_suggestion'];
const suggestionRows: string[][] = Object.entries(suggestionCategoryTable)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([cat, s]) => {
		const pctOfTotal = (x: integer) => s.total > 0 ? `${x} (${((x / s.total) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		const pctOfTested = (x: integer) => s.tested > 0 ? `${x} (${((x / s.tested) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		const pctOfHolesTested = (x: integer) => s.holesTested > 0 ? `${x} (${((x / s.holesTested) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		return [cat, String(s.total), pctOfTotal(s.withHoles), pctOfTotal(s.tested), pctOfTested(s.compiled), pctOfHolesTested(s.holesWithValid)];
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

// Print per-category hole-type compile stats table
const holeTypeColHeaders = ['category', 'hole_types_tested', 'hole_types_compiled'];
const holeTypeRows: string[][] = Object.entries(holeTypeCategoryTable)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([cat, s]) => {
		const pctOfTested = (x: integer) => s.tested > 0 ? `${x} (${((x / s.tested) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		return [cat, String(s.tested), pctOfTested(s.compiled)];
	});

const holeTypeColWidths = holeTypeColHeaders.map((h, i) => Math.max(h.length, ...holeTypeRows.map(r => r[i].length)));
const holeTypeFmt = (row: string[]) => row.map((cell, i) => cell.padEnd(holeTypeColWidths[i])).join('  ');
const holeTypeSep = holeTypeColWidths.map(w => '-'.repeat(w)).join('  ');

const holeTypeTableLines = [
	'\n=== Hole Type Compile Stats by Hole Category ===',
	...(compileTypes ? [] : ['(Run with --compile-types to populate hole_types_tested/hole_types_compiled)']),
	holeTypeFmt(holeTypeColHeaders),
	holeTypeSep,
	...holeTypeRows.map(holeTypeFmt),
];
for (const line of holeTypeTableLines) console.log(line);

// Print per-category matched-type stats table
const matchedTypeColHeaders = ['category', 'types_tested', 'types_matched'];
const matchedTypeRows: string[][] = Object.entries(matchedTypeCategoryTable)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([cat, s]) => {
		const pctOfTested = (x: integer) => s.tested > 0 ? `${x} (${((x / s.tested) * 100).toFixed(2)}%)` : `${x} (0.00%)`;
		return [cat, String(s.tested), pctOfTested(s.matched)];
	});

const matchedTypeColWidths = matchedTypeColHeaders.map((h, i) => Math.max(h.length, ...matchedTypeRows.map(r => r[i].length)));
const matchedTypeFmt = (row: string[]) => row.map((cell, i) => cell.padEnd(matchedTypeColWidths[i])).join('  ');
const matchedTypeSep = matchedTypeColWidths.map(w => '-'.repeat(w)).join('  ');

const matchedTypeTableLines = [
	'\n=== Matched Type Stats by Hole Category ===',
	matchedTypeFmt(matchedTypeColHeaders),
	matchedTypeSep,
	...matchedTypeRows.map(matchedTypeFmt),
];
for (const line of matchedTypeTableLines) console.log(line);

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

const holeTypeTablePath = path.join(generatedDir, 'eval_hole_type_table.txt');
fs.writeFileSync(holeTypeTablePath, holeTypeTableLines.join('\n') + '\n');
console.log(`Hole type table written to ${holeTypeTablePath}`);

const matchedTypeTablePath = path.join(generatedDir, 'eval_matched_type_table.txt');
fs.writeFileSync(matchedTypeTablePath, matchedTypeTableLines.join('\n') + '\n');
console.log(`Matched type table written to ${matchedTypeTablePath}`);
