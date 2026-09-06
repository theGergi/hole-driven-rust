import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import TypeChecker from './TypeChecker';
import { Hole, SourceLocation, Variable, Function as Func, Type } from '../../shared/out/types.js';
import { toType, printHoleSuggestionContext, formatType } from './utils.js';
import { RustParserListener } from './parser/RustParserListener';
import { ParseTreeWalker } from 'antlr4ng';
import { UsageGraphListener } from './UsageListener';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseStdJsonFile } from './stdParser';
import { constructTypeString, formatFunction, formatVariable } from '../../shared/out/types.js';

const stdParseResult = parseStdJsonFile();

const OWNERSHIP = !process.argv.includes('--no-ownership');

function parseDocument(code: string, ownership: boolean = OWNERSHIP): Hole[] {
	const inputStream = CharStream.fromString(code);
	
	// 1. Lexer: Breaks text into tokens
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);
	
	// 2. Parser: Builds the logic tree
	const parser = new RustParser(tokenStream);
	
	const tree = parser.crate(); 

	const listener = new UsageGraphListener();
	ParseTreeWalker.DEFAULT.walk(listener, tree);
	console.log(listener.getUsages());

	const interpreter = new TypeChecker(listener, stdParseResult, ownership) as any;
	interpreter.visit(tree)

	const result = interpreter.holes;
	// interpreter.getFinalResult()
	return result;
}

function parseDocumentForUsageGraph(code: string) {
	const inputStream = CharStream.fromString(code);

	// 1. Lexer: Breaks text into tokens
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);

	// 2. Parser: Builds the logic tree
	const parser = new RustParser(tokenStream);
	
	const tree = parser.crate();
	
	// 3. Walk the tree with the usage graph listener
	const listener = new UsageGraphListener();
	ParseTreeWalker.DEFAULT.walk(listener, tree);
	
	console.log(listener.getUsages());
	console.log(listener.isVariableFree('x', 'block_1', 5));

	return listener.getUsages();
}


function matchesSubset(source: Type, subset: Partial<Type>): boolean {
  const keys = Object.keys(subset) as Array<keyof Type>;

  return keys.every((key) => {
    const sourceValue = source[key];
    const subsetValue = subset[key];

    // Recurse when both values are non-null objects (e.g. nested Type like elementType)
    if (subsetValue !== null && typeof subsetValue === 'object' &&
        sourceValue !== null && typeof sourceValue === 'object') {
      return matchesSubset(sourceValue as Type, subsetValue as Partial<Type>);
    }

    if (sourceValue === subsetValue) {
      return true;
    }
    console.log(`Key ${key} does not match: source has ${JSON.stringify(sourceValue)}, subset has ${JSON.stringify(subsetValue)}`);
    return false;
  });
}

type ExpectedHole = { line: number; type: Type; suggestionNames: string[]; wrongSuggestionNames?: string[] };

type ExpectedFile = ExpectedHole[] | { ownership?: boolean; holes: ExpectedHole[] };

function readExpected(raw: string): { expectedHoles: ExpectedHole[]; ownership: boolean } {
	const parsed = JSON.parse(raw) as ExpectedFile;
	if (Array.isArray(parsed)) {
		return { expectedHoles: parsed, ownership: OWNERSHIP };
	}
	return { expectedHoles: parsed.holes, ownership: parsed.ownership ?? OWNERSHIP };
}

function runTest(testcase: {rustCode: string, expectedHoles: ExpectedHole[], ownership: boolean}) {
	const result = parseDocument(testcase.rustCode, testcase.ownership);
	result.forEach(hole => printHoleSuggestionContext(hole));
	// Automated test for holes
	assert.strictEqual(result.length, testcase.expectedHoles.length, 'Should have the correct number of holes');
	console.log(result)
	for (let i = 0; i < testcase.expectedHoles.length; i++) {
		const hole = result[i] as Hole;
		const expected = testcase.expectedHoles[i];
		assert.strictEqual(hole.location.line, expected.line, `Hole ${i} line mismatch`);
		assert.strictEqual(matchesSubset(hole.type, expected.type), true, `Hole ${i} type mismatch`);
		const actualNames = hole.suggestions.map(s => s.suggestionNameNoParams);
		const expectedNames = expected.suggestionNames;
		for (const name of expectedNames) {
			assert.ok(actualNames.includes(name), `Hole ${i} suggestion name missing: ${name}`);
		}
		const wrongNames = expected.wrongSuggestionNames ?? [];
		for (const name of wrongNames) {
			assert.ok(!actualNames.includes(name), `Hole ${i} suggestion name should not be present: ${name}`);
		}
	}

	console.log('Test passed!');
}

// Recursively collect test cases in nested folders
const testCasesDir = path.resolve(process.cwd(), 'server', 'src', 'test_cases');

function collectTestCases(dir: string, rootDir: string = dir): Array<{ name: string; rustFile: string; expectedFile: string }> {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const testCases: Array<{ name: string; rustFile: string; expectedFile: string }> = [];
	const hasExpected = entries.some(entry => entry.isFile() && entry.name === 'expected.json');

	if (hasExpected) {
		const rustFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.rs')).map(entry => entry.name);
		if (rustFiles.length === 0) {
			throw new Error(`Test folder ${dir} contains expected.json but no .rs file.`);
		}

		for (const rustFile of rustFiles) {
			testCases.push({
				name: path.relative(rootDir, path.join(dir, rustFile)),
				rustFile: path.join(dir, rustFile),
				expectedFile: path.join(dir, 'expected.json')
			});
		}
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			testCases.push(...collectTestCases(path.join(dir, entry.name), rootDir));
		}
	}

	return testCases;
}

const testCases = collectTestCases(testCasesDir);

// Get test name filter from command line arguments (e.g., "Move/testCase2c"), skipping flags
const testFilter = process.argv.slice(2).find(a => !a.startsWith('--'));

// Filter the cases if a name was provided
const casesToRun = testFilter 
    ? testCases.filter(t => t.name.includes(testFilter)) 
    : testCases;

if (casesToRun.length === 0) {
    console.warn(`No test cases found matching: "${testFilter}"`);
    process.exit(0);
}

// Run the tests. Each case is isolated so one failure doesn't abort the whole run.
const failures: Array<{ name: string; error: string }> = [];

for (const testCaseDef of casesToRun) {
    console.log(`Running test for ${testCaseDef.name}`);
    try {
        const rustCode = fs.readFileSync(testCaseDef.rustFile, 'utf8');
        const { expectedHoles, ownership } = readExpected(fs.readFileSync(testCaseDef.expectedFile, 'utf8'));
        runTest({ rustCode, expectedHoles, ownership });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Test failed for ${testCaseDef.name}: ${message}`);
        failures.push({ name: testCaseDef.name, error: message });
    }
}

// Summary
const passed = casesToRun.length - failures.length;
console.log(`\n================ TEST SUMMARY ================`);
console.log(`${passed}/${casesToRun.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log(`\nFailing tests:`);
    for (const failure of failures) {
        console.log(`  ✗ ${failure.name}`);
        console.log(`      ${failure.error}`);
    }
}
console.log(`=============================================`);

process.exit(failures.length > 0 ? 1 : 0);

// async function main() {
//     const result = await parseStdJsonFile();
//     // console.log(result);
// 	const functionLines = result.functions.map(func => {
// 		// console.log(func)
// 		return formatFunction(func);
// 	}) ?? [];
// 	// console.log(functionLines.join('\n'));
// }

// main().catch((err) => {
//     console.error(err);
//     process.exit(1);
// });

// console.log()
