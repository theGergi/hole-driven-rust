import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import MyInterpreter, { Hole, SourceLocation, Variable, Function as Func, toType, Type } from './MyInterpreter.js';
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
			type: { valType: 'Vec', elementType: 'i32' },
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
			type: { valType: 'string' },
			suggestionNames: ['x', 'main', 'a']
		},
		{
			line: 8,
			type: { valType: 'string' },
			suggestionNames: ['y', 'main', 'a']
		},
		{
			line: 10,
			type: { valType: 'string' },
			suggestionNames: ['r', 'z', 'main', 'a']
		}
	] as any
}

const testCase3 = {
	rustCode: `
fn immutable_borrow(s: &string) {
	// We can read the value
	println!("I'm reading: {}", s);
}

fn mutable_borrow(s: &mut string) {
	// We can change the value
	s.push_str("... modified!");
	println!("Updated: {}", s);
}
	
fn main() {
	let mut s = "hello";
		
	let s_imm_borrow: &string = &s; // Immutable borrow

	immutable_borrow(??); // s_imm_borrow or &s should be suggested
		
	let s_imm_borrow_2: &string = ??; // s should be suggested again since 
							// immutable borrow can happen more than once

	immutable_borrow(??); // s_imm_borrow, s_imm_borrow_2 or &s should be suggested
		
	// let s_mut_borrow = ??; // No suggestions since s_imm_borrow is used later
	// 												// And immutable and mutable borrows cannot exist at the same time
		
	// mutable_borrow(??);   // no suggestions since s_imm_borrow is used later

	// immutable_borrow(&s); 

	// let s_mut_borrow = ??; // &mut s    since no immutable borrow later

	// mutable_borrow(??);   // &mut s		since no immutable borrow later
}
`,
	expectedHoles: [
		{
			line: 18,
			type: { valType: 'reference', elementType: 'string' },
			suggestionNames: ['s_imm_borrow', '&s']
		},
		{
			line: 20,
			type: { valType: 'reference', elementType: 'string' },
			suggestionNames: ['s_imm_borrow', '&s']
		},
		{
			line: 23,
			type: { valType: 'reference', elementType: 'string' },
			suggestionNames: ['s_imm_borrow', 's_imm_borrow_2', '&s']
		},
	] as any
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
	console.log(result);
	// Automated test for holes
	assert.strictEqual(result.length, testcase.expectedHoles.length, 'Should have the correct number of holes');
	console.log(result)
	for (let i = 0; i < testcase.expectedHoles.length; i++) {
		const hole = result[i] as Hole;
		const expected = testcase.expectedHoles[i];
		assert.strictEqual(hole.location.line, expected.line, `Hole ${i} line mismatch`);
		assert.strictEqual(matchesSubset(hole.type, expected.type), true, `Hole ${i} type mismatch`);
		const actualNames = hole.suggestions.map(s => s.suggestion.name).sort();
		const expectedNames = expected.suggestionNames.sort();
		assert.deepStrictEqual(actualNames, expectedNames, `Hole ${i} suggestion names mismatch`);
	}

	console.log('Test passed!');
}

// runTest(testCase);
// runTest(testCase2);
runTest(testCase3);