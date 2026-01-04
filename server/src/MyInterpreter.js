import ToyLangVisitor from './parser/ToyLangVisitor.js';

export default class MyInterpreter extends ToyLangVisitor {
  // Matches 'program: statement+'
  visitProgram(ctx) {
    // Visit every statement in the program
    return ctx.statement().map(stmt => this.visit(stmt));
  }

  // Matches 'statement: print expression'
  visitStatement(ctx) {
    const value = this.visit(ctx.expression());
    console.log(`> ${value}`);
    return value;
  }

  // Matches 'expression: INT'
  visitExpression(ctx) {
    // Return the integer value of the token
    return parseInt(ctx.INT().getText());
  }
}