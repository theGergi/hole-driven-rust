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
import { parseStdJsonFile } from './stdParser';
import {
	TestCaseMeta,
	collectTestCases,
	resolveDataset,
	evalCargoDir,
	evalLibPath,
	frac,
	avg,
	categoriesOf,
	metaCategories,
	isExactMatch,
	renderTextTable,
	renderMarkdownTable,
} from './evalShared';

const MAX_SUGGESTIONS_TO_COMPILE = 5;

const maxSuggestionsArg = process.argv.find(a => a.startsWith('--max-suggestions='));
const maxSuggestionsRaw = maxSuggestionsArg?.slice('--max-suggestions='.length);
const MAX_RECORDED_SUGGESTIONS =
	maxSuggestionsRaw === undefined ? 25
	: maxSuggestionsRaw === 'all' ? Infinity
	: parseInt(maxSuggestionsRaw, 10) || Infinity;

type EvalCategory = 'failed_with_error' | 'found_type' | 'found_suggestions' | 'exact_match' | 'failed';

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
	suggestions?: string[];
	// The suggestion at exact_match_rank, so a hit stays visible past the cap.
	matched_suggestion?: string;
	suggestion_compile_results?: SuggestionCompileResult[];
	any_suggestion_compiles?: boolean;
	suggestions_with_holes?: string[];
	hole_type?: string;
	hole_sub_types?: string[];
	hole_type_compiles?: boolean;
	hole_type_compile_error?: string;
	expected_type?: string;
	matched_type?: boolean;
	matched_top_type?: boolean;
	exact_match_rank?: number | null;
}

const stdParseResult = parseStdJsonFile();

// Toggle ownership on or off
const OWNERSHIP = !process.argv.includes('--no-ownership');

function parseDocument(code: string): Hole[] {
	const inputStream = CharStream.fromString(code);
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);
	const parser = new RustParser(tokenStream);
	const tree = parser.crate();
	const listener = new UsageGraphListener();
	ParseTreeWalker.DEFAULT.walk(listener, tree);
	const interpreter = new TypeChecker(listener, stdParseResult, OWNERSHIP) as any;
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

// Whether the reported type matches
function topTypeMatches(foundType: string, expectedType: string): boolean {
	if (normalizeType(expectedType) === "&str" && normalizeType(foundType) === "&String") {
		return true;
	}

	return normalizeType(foundType) === normalizeType(expectedType);
}

// Whether any type matches
function typesMatch(foundType: string, expectedType: string, holeSupTypes?: string[]): boolean {
	return topTypeMatches(foundType, expectedType)
		|| (holeSupTypes?.some(st => topTypeMatches(st, expectedType)) ?? false);
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
	const holeSubTypes = typeKnown && hole.subTypes && hole.subTypes.length > 0 ? hole.subTypes.map(st => st.toTypeString()) : undefined;
	const hasSuggestions = hole.suggestions && hole.suggestions.length > 0;
	const exactMatch = hasSuggestions && hole.suggestions.some(s => isExactMatch(s.suggestionNameNoParams ?? '', meta.original));

	const suggestionNames = hasSuggestions
		? hole.suggestions.map((s: any) => s.suggestionNameNoParams as string)
		: [];

	if (exactMatch) return { category: 'exact_match', suggestions: suggestionNames, holeType, holeSubTypes };
	if (hasSuggestions) return { category: 'found_suggestions', suggestions: suggestionNames, holeType, holeSubTypes };
	if (typeKnown) return { category: 'found_type', holeType, holeSubTypes };
	return { category: 'failed', error: 'No type or suggestions found' };
}

const compileSuggestions = process.argv.includes('--compile-suggestions');
const compileTypes = process.argv.includes('--compile-types');

const { dataset, datasetDir: generatedDir } = resolveDataset('strategy1');
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
let totalTopTypesMatched = 0;

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

	// Rank of the exact ground-truth match within the tool's ordered suggestions.
	let exact_match_rank: number | null = null;
	if (suggestions && suggestions.length > 0) {
		const idx = suggestions.findIndex(name => isExactMatch(name, meta.original));
		exact_match_rank = idx >= 0 ? idx : null;
	}

	// Ranks are the array indices, so the recorded list has to stay a prefix.
	const recorded_suggestions = suggestions?.slice(0, MAX_RECORDED_SUGGESTIONS);
	const matched_suggestion = exact_match_rank !== null ? suggestions![exact_match_rank] : undefined;

	let matched_type: boolean | undefined;
	let matched_top_type: boolean | undefined;
	if (meta.type && holeType) {
		matched_type = typesMatch(holeType, meta.type, holeSubTypes);
		matched_top_type = topTypeMatches(holeType, meta.type);
		totalTypesTested++;
		if (matched_type) totalTypesMatched++;
		if (matched_top_type) totalTopTypesMatched++;
	}

	results.push({
		task: tc.task,
		hole: tc.hole,
		category,
		holeCategories: metaCategories(meta),
		error,
		suggestion_count,
		suggestions: recorded_suggestions,
		matched_suggestion,
		suggestion_compile_results,
		any_suggestion_compiles,
		suggestions_with_holes,
		hole_type: holeType,
		hole_sub_types: holeSubTypes,
		hole_type_compiles,
		hole_type_compile_error,
		expected_type: meta.type,
		matched_type,
		matched_top_type,
		exact_match_rank,
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
console.log(`Types matched (reported type): ${totalTopTypesMatched}`);
if (totalTypesTested > 0) {
	const pct = ((totalTypesMatched / totalTypesTested) * 100).toFixed(1);
	const topPct = ((totalTopTypesMatched / totalTypesTested) * 100).toFixed(1);
	console.log(`Match rate:                    ${pct}%`);
	console.log(`Match rate (reported type):    ${topPct}%`);
}

type FitBucket = 'failed_with_error' | 'failed' | 'fit_incorrect' | 'fit_correct';
const fitBuckets: FitBucket[] = ['failed_with_error', 'failed', 'fit_incorrect', 'fit_correct'];

function isFitCorrect(r: EvalResult): boolean {
	return r.category === 'exact_match' || r.matched_type === true || r.any_suggestion_compiles === true;
}

function fitBucketOf(r: EvalResult): FitBucket {
	if (r.category === 'failed_with_error') return 'failed_with_error';
	if (r.category === 'failed') return 'failed';
	return isFitCorrect(r) ? 'fit_correct' : 'fit_incorrect';
}

interface CategoryStats extends Record<FitBucket, number> {
	exactMatch: number;
	matchedType: number;
	validSuggestion: number;
	suggestionSum: number;
	suggestionHoles: number;
	rankSum: number;
	rankHits: number;
}
const newCategoryStats = (): CategoryStats => ({
	failed_with_error: 0, failed: 0, fit_incorrect: 0, fit_correct: 0,
	exactMatch: 0, matchedType: 0, validSuggestion: 0,
	suggestionSum: 0, suggestionHoles: 0, rankSum: 0, rankHits: 0,
});

// The tool's rank for a hole, 1 based
const rankOf = (r: EvalResult): number | undefined =>
	r.exact_match_rank === null || r.exact_match_rank === undefined ? undefined : r.exact_match_rank + 1;

const categoryTable: Record<string, CategoryStats> = {};
for (const r of results) {
	const bucket = fitBucketOf(r);
	const rank = rankOf(r);
	for (const cat of categoriesOf(r.holeCategories)) {
		const s = (categoryTable[cat] ??= newCategoryStats());
		s[bucket]++;
		if (r.category === 'exact_match') s.exactMatch++;
		if (r.matched_type) s.matchedType++;
		if (r.any_suggestion_compiles) s.validSuggestion++;
		if (r.suggestion_count !== undefined) { s.suggestionSum += r.suggestion_count; s.suggestionHoles++; }
		if (rank !== undefined) { s.rankSum += rank; s.rankHits++; }
	}
}

const grandTotal = results.length;
const totalFitCorrect = results.filter(r => fitBucketOf(r) === 'fit_correct').length;
const totalFitIncorrect = results.filter(r => fitBucketOf(r) === 'fit_incorrect').length;

const catTotal = (s: CategoryStats) => fitBuckets.reduce((sum, k) => sum + s[k], 0);
const sortedCategories = Object.entries(categoryTable).sort(([a], [b]) => a.localeCompare(b));

const table1Headers = ['category', 'failed_with_error', 'failed', 'fit_incorrect', 'fit_correct', 'total'];
const table1Rows: string[][] = sortedCategories.map(([cat, s]) => {
	const total = catTotal(s);
	return [cat, frac(s.failed_with_error, total), frac(s.failed, total), frac(s.fit_incorrect, total), frac(s.fit_correct, total), String(total)];
});
const table1TotalRow = ['Total', frac(counts.failed_with_error, grandTotal), frac(counts.failed, grandTotal), frac(totalFitIncorrect, grandTotal), frac(totalFitCorrect, grandTotal), String(grandTotal)];

const holesWithSuggestions = results.filter(r => r.suggestion_count !== undefined);
const totalSuggestionSum = holesWithSuggestions.reduce((sum, r) => sum + r.suggestion_count!, 0);
const ranks = results.map(rankOf).filter((rank): rank is number => rank !== undefined);
const totalRankSum = ranks.reduce((sum, rank) => sum + rank, 0);

const table2Headers = ['category', 'exact_match', 'matched_type', 'valid_suggestion', 'avg_suggestions', 'avg_rank'];
const table2Rows: string[][] = sortedCategories.map(([cat, s]) => {
	const total = catTotal(s);
	return [
		cat,
		frac(s.exactMatch, total),
		frac(s.matchedType, total),
		frac(s.validSuggestion, total),
		avg(s.suggestionSum, s.suggestionHoles),
		avg(s.rankSum, s.rankHits),
	];
});
const table2TotalRow = [
	'Total',
	frac(counts.exact_match, grandTotal),
	frac(totalTypesMatched, grandTotal),
	frac(totalHolesWithValidSuggestion, grandTotal),
	avg(totalSuggestionSum, holesWithSuggestions.length),
	avg(totalRankSum, ranks.length),
];

const table2Subtitle = '(avg_suggestions = mean list length over holes that produced suggestions; '
	+ 'avg_rank = mean 1-based rank of the ground truth, over the holes where it was suggested at all)';

const table1Lines = ['\n=== Results by Hole Category (failed / fit correctness) ===', ...renderTextTable(table1Headers, table1Rows, table1TotalRow)];
const table2Lines = ['\n=== Results by Hole Category (match quality) ===', table2Subtitle, ...renderTextTable(table2Headers, table2Rows, table2TotalRow)];
const tableLines = [...table1Lines, ...table2Lines];
for (const line of tableLines) console.log(line);

const jsonPath = path.join(generatedDir, 'eval_results.json');
fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
console.log(`\nResults written to ${jsonPath}`);

const tablePath = path.join(generatedDir, 'eval_table.txt');
fs.writeFileSync(tablePath, tableLines.join('\n') + '\n');
console.log(`Table written to ${tablePath}`);

const markdownSection = (title: string, headers: string[], rows: string[][], totalRow: string[], subtitle?: string): string[] =>
	[`### ${title}`, '', ...(subtitle ? [subtitle, ''] : []), ...renderMarkdownTable(headers, rows, totalRow.map(c => `**${c}**`)), ''];
const mdLines = [
	...markdownSection('Results by Hole Category (failed / fit correctness)', table1Headers, table1Rows, table1TotalRow),
	...markdownSection('Results by Hole Category (match quality)', table2Headers, table2Rows, table2TotalRow, table2Subtitle),
];
const mdPath = path.join(generatedDir, 'eval_table.md');
fs.writeFileSync(mdPath, mdLines.join('\n') + '\n');
console.log(`Markdown table written to ${mdPath}`);