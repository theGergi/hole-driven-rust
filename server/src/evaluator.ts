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

type EvalCategory = 'failed_with_error' | 'found_type' | 'found_suggestions' | 'exact_match';

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
	error?: string;
	suggestion_compile_results?: SuggestionCompileResult[];
}

const evalCargoDir = path.resolve(process.cwd(), 'server', 'eval_cargo');
const evalLibPath = path.join(evalCargoDir, 'src', 'lib.rs');

function parseDocument(code: string): Hole[] {
	const inputStream = CharStream.fromString(code);
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);
	const parser = new RustParser(tokenStream);
	const tree = parser.crate();
	const listener = new UsageGraphListener();
	ParseTreeWalker.DEFAULT.walk(listener, tree);
	const interpreter = new TypeChecker(listener) as any;
	interpreter.visit(tree);
	return interpreter.holes;
}

function checkCompiles(rustCode: string, suggestionName: string): boolean {
	// Skip suggestions that still contain holes — they can't compile as-is
	if (suggestionName.includes('??')) return false;

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
	const exactMatch = hasSuggestions && hole.suggestions.some(s => s.suggestion?.name === meta.original);

	const suggestionNames = hasSuggestions
		? hole.suggestions.map((s: any) => s.suggestion?.name as string).filter(Boolean)
		: [];

	if (exactMatch) return { category: 'exact_match', suggestions: suggestionNames };
	if (hasSuggestions) return { category: 'found_suggestions', suggestions: suggestionNames };
	if (typeKnown) return { category: 'found_type' };
	return { category: 'failed_with_error', error: 'No type or suggestions found' };
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

const generatedDir = path.resolve(process.cwd(), 'server', 'src', 'generated_test_cases');
const cases = collectTestCases(generatedDir);

const results: EvalResult[] = [];
const counts: Record<EvalCategory, number> = {
	failed_with_error: 0,
	found_type: 0,
	found_suggestions: 0,
	exact_match: 0,
};
let totalSuggestionsTested = 0;
let totalSuggestionsCompile = 0;

// Suppress console output from the tool during evaluation
const origLog = console.log;
console.log = () => {};

for (const tc of cases) {
	const rustCode = fs.readFileSync(tc.rsFile, 'utf8');
	const meta: TestCaseMeta = JSON.parse(fs.readFileSync(tc.jsonFile, 'utf8'));
	const { category, error, suggestions } = evaluateHole(rustCode, meta);

	let suggestion_compile_results: SuggestionCompileResult[] | undefined;

	if (suggestions && suggestions.length > 0) {
		suggestion_compile_results = suggestions.map(name => {
			const compiles = checkCompiles(rustCode, name);
			totalSuggestionsTested++;
			if (compiles) totalSuggestionsCompile++;
			return { name, compiles };
		});
	}

	results.push({ task: tc.task, hole: tc.hole, category, error, suggestion_compile_results });
	counts[category]++;
}

console.log = origLog;

// Print per-result summary
for (const r of results) {
	const suffix = r.error ? ` — ${r.error}` : '';
	let compileSuffix = '';
	if (r.suggestion_compile_results) {
		const passing = r.suggestion_compile_results.filter(s => s.compiles).map(s => s.name);
		const failing = r.suggestion_compile_results.filter(s => !s.compiles).map(s => s.name);
		const parts: string[] = [];
		if (passing.length) parts.push(`compiles: [${passing.join(', ')}]`);
		if (failing.length) parts.push(`no-compile: [${failing.join(', ')}]`);
		compileSuffix = ' | ' + parts.join(' | ');
	}
	console.log(`${r.task}/${r.hole}: ${r.category}${suffix}${compileSuffix}`);
}

// Print aggregate counts
console.log('\n=== Summary ===');
console.log(`Total holes:             ${results.length}`);
console.log(`exact_match:             ${counts.exact_match}`);
console.log(`found_suggestions:       ${counts.found_suggestions}`);
console.log(`found_type:              ${counts.found_type}`);
console.log(`failed_with_error:       ${counts.failed_with_error}`);
console.log(`\nSuggestions tested:      ${totalSuggestionsTested}`);
console.log(`Suggestions compile:     ${totalSuggestionsCompile}`);
if (totalSuggestionsTested > 0) {
	const pct = ((totalSuggestionsCompile / totalSuggestionsTested) * 100).toFixed(1);
	console.log(`Compile rate:            ${pct}%`);
}

// Write results to JSON
const outputPath = path.resolve(process.cwd(), 'server', 'src', 'eval_results.json');
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\nResults written to ${outputPath}`);
