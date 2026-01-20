import { CharStream, CommonTokenStream } from 'antlr4ng';
import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import MyInterpreter from './MyInterpreter.js';

const interpreter = new MyInterpreter() as any;

function parseDocument(code: string) {
	const inputStream = CharStream.fromString(code);

	// 1. Lexer: Breaks text into tokens
	const lexer = new RustLexer(inputStream);
	const tokenStream = new CommonTokenStream(lexer);

	// 2. Parser: Builds the logic tree
	const parser = new RustParser(tokenStream);
	
	const tree = parser.crate(); 

	return interpreter.visit(tree);
}

// --- Test Case ---
const rustCode = `
    fn main() -> i32 {
        let x;
    }
`;

const result = parseDocument(rustCode);
console.log(result)