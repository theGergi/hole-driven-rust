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



function parseDocument(code: string): Hole[] {
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

	const interpreter = new TypeChecker(listener) as any;
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
  // Get keys from the subset to define the scope of the comparison
  const keys = Object.keys(subset) as Array<keyof Type>;

  return keys.every((key) => {
    const sourceValue = source[key];
    const subsetValue = subset[key];

    // Basic equality check (Works for primitives like string, number, boolean)
    if (sourceValue === subsetValue) {
      return true;
    }
	console.log(`Key ${key} does not match: source has ${sourceValue}, subset has ${subsetValue}`);
    return false;
  });
}

function runTest(testcase: {rustCode: string, expectedHoles: { line: number; type: Type; suggestionNames: string[] }[]}) {
	const result = parseDocument(testcase.rustCode);
	result.forEach(hole => printHoleSuggestionContext(hole));
	// Automated test for holes
	assert.strictEqual(result.length, testcase.expectedHoles.length, 'Should have the correct number of holes');
	console.log(result)
	for (let i = 0; i < testcase.expectedHoles.length; i++) {
		const hole = result[i] as Hole;
		const expected = testcase.expectedHoles[i];
		assert.strictEqual(hole.location.line, expected.line, `Hole ${i} line mismatch`);
		assert.strictEqual(matchesSubset(hole.type, expected.type), true, `Hole ${i} type mismatch`);
		const actualNames = hole.suggestions.map(s => s.suggestion.name);
		const expectedNames = expected.suggestionNames;
		for (const name of expectedNames) {
			assert.ok(actualNames.includes(name), `Hole ${i} suggestion name missing: ${name}`);
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

// Get test name filter from command line arguments (e.g., "Move/testCase2c")
const testFilter = process.argv[2]; 

// Filter the cases if a name was provided
const casesToRun = testFilter 
    ? testCases.filter(t => t.name.includes(testFilter)) 
    : testCases;

if (casesToRun.length === 0) {
    console.warn(`No test cases found matching: "${testFilter}"`);
    process.exit(0);
}

// Run the tests
for (const testCaseDef of casesToRun) {
    const rustCode = fs.readFileSync(testCaseDef.rustFile, 'utf8');
    const expectedHoles = JSON.parse(fs.readFileSync(testCaseDef.expectedFile, 'utf8')) as any;
    console.log(`Running test for ${testCaseDef.name}`);
    runTest({ rustCode, expectedHoles });
}

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
