import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import MyInterpreter, { Hole, SourceLocation, Variable, Function as Func } from './MyInterpreter.js';
import * as assert from 'assert';

const interpreter = new MyInterpreter() as any;

function parseDocument(code: string) {
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


// --- Test Case ---
const rustCode2 = `
fn main(a: string) -> string {
	{
		let x = "3";
		let z = ??;
	}
	let y = "4";
	let z = ??;
	let r = y;
	let m = ??;
}
`;

const rustCode = `
fn main(a: string) -> string {
	let a = vec![1, 2, 3];
}
`;

const expectedHoles = [
	// {
	// 	line: 5,
	// 	type: 'string',
	// 	suggestionNames: ['x', 'main']
	// },
	// {
	// 	line: 8,
	// 	type: 'string',
	// 	suggestionNames: ['y', 'main']
	// },
	// {
	// 	line: 10,
	// 	type: 'string',
	// 	suggestionNames: ['r', 'main']
	// }
] as any;

function runTest(rustCode: string, expectedHoles: { line: number; type: string; suggestionNames: string[] }[]) {
	const result = parseDocument(rustCode);

	// Automated test for holes
	assert.strictEqual(result.length, expectedHoles.length, 'Should have the correct number of holes');

	for (let i = 0; i < expectedHoles.length; i++) {
		const hole = result[i] as Hole;
		const expected = expectedHoles[i];
		assert.strictEqual(hole.location.line, expected.line, `Hole ${i} line mismatch`);
		assert.strictEqual(hole.type, expected.type, `Hole ${i} type mismatch`);
		const actualNames = hole.suggestions.map(s => s.suggestion.name).sort();
		const expectedNames = expected.suggestionNames.sort();
		assert.deepStrictEqual(actualNames, expectedNames, `Hole ${i} suggestion names mismatch`);
	}

	console.log('Test passed!');
}

runTest(rustCode, expectedHoles);