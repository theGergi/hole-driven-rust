import antlr4 from 'antlr4';
import ToyLangLexer from '../parser/ToyLangLexer.js';
import ToyLangParser from '../parser/ToyLangParser.js';
import MyInterpreter from './MyInterpreter.js';

const code = "print 10; print 20;";
const chars = new antlr4.InputStream(code);
const lexer = new ToyLangLexer(chars);
const tokens = new antlr4.CommonTokenStream(lexer);
const parser = new ToyLangParser(tokens);

// 1. Build the Parse Tree
const tree = parser.program(); 

// 2. Execute using the Visitor
const interpreter = new MyInterpreter();
interpreter.visit(tree);