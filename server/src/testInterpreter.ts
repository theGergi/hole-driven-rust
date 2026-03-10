import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import MyInterpreter, { Hole, SourceLocation, Variable, Function as Func } from './MyInterpreter.js';
import * as assert from 'assert';



function parseDocument(code: string) {
	const interpreter = new MyInterpreter() as any;
	const inputStream = CharStream.fromString(code);

	// 1. Lexer: Breaks text into tokens
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);

	// 2. Parser: Builds the logic tree
	const parser = new RustParser(tokenStream);
	
	const tree = parser.crate(); 
	interpreter.visit(tree)
	const result = interpreter.holes;
	// interpreter.getFinalResult()
	return result;
}


const testCase = {
	rustCode: `
fn main(a: string) -> i32 {
	let a = vec![1, 2, 3];
	let c: Vec<i32> = ??;
}
`,
	expectedHoles: [
		{
			line: 4,
			type: { kind: 'Vec', elementType: { kind: 'i32' } },
			suggestionNames: ['a']
		},
	] as any
}

// --- Test Case ---
const testCase2 = {rustCode:`
fn main(a: string) -> string {
	{
		let x = "3";
		let z:string = ??;
	}
	let y = "4";
	let z:string = ??;
	let r = y;
	let m:string = ??;
}
`, expectedHoles: [
		{
			line: 5,
			type: { kind: 'string' },
			suggestionNames: ['x', 'main']
		},
		{
			line: 8,
			type: { kind: 'string' },
			suggestionNames: ['y', 'main']
		},
		{
			line: 10,
			type: { kind: 'string' },
			suggestionNames: ['r', 'z', 'main']
		}
	] as any
}

function runTest(testcase: {rustCode: string, expectedHoles: { line: number; type: string; suggestionNames: string[] }[]}) {
	const result = parseDocument(testcase.rustCode);
	console.log(result);
	// Automated test for holes
	assert.strictEqual(result.length, testcase.expectedHoles.length, 'Should have the correct number of holes');

	for (let i = 0; i < testcase.expectedHoles.length; i++) {
		const hole = result[i] as Hole;
		const expected = testcase.expectedHoles[i];
		assert.strictEqual(hole.location.line, expected.line, `Hole ${i} line mismatch`);
		assert.deepStrictEqual(hole.type, expected.type, `Hole ${i} type mismatch`);
		const actualNames = hole.suggestions.map(s => s.suggestion.name).sort();
		const expectedNames = expected.suggestionNames.sort();
		assert.deepStrictEqual(actualNames, expectedNames, `Hole ${i} suggestion names mismatch`);
	}

	console.log('Test passed!');
}

runTest(testCase);
runTest(testCase2);