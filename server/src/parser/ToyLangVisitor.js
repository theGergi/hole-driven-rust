// Generated from ToyLang.g4 by ANTLR 4.13.2
// jshint ignore: start
import antlr4 from 'antlr4';

// This class defines a complete generic visitor for a parse tree produced by ToyLangParser.

export default class ToyLangVisitor extends antlr4.tree.ParseTreeVisitor {

	// Visit a parse tree produced by ToyLangParser#program.
	visitProgram(ctx) {
	  return this.visitChildren(ctx);
	}


	// Visit a parse tree produced by ToyLangParser#statement.
	visitStatement(ctx) {
	  return this.visitChildren(ctx);
	}


	// Visit a parse tree produced by ToyLangParser#expression.
	visitExpression(ctx) {
	  return this.visitChildren(ctx);
	}
}