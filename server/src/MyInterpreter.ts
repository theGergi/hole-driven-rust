import { RustParserVisitor } from './parser/RustParserVisitor';
import { HoleExpressionContext } from './parser/RustParser';
import { Token } from 'antlr4ng';

export interface HoleLocation {
    line: number;
    character: number;
    length: number;
}

export default class MyInterpreter extends RustParserVisitor<HoleLocation[]> {
    // Initialize with an empty array
    protected defaultResult(): HoleLocation[] {
        return [];
    }

    // Combine results from different branches of the tree
    protected aggregateResult(aggregate: HoleLocation[], nextResult: HoleLocation[]): HoleLocation[] {
        return [...aggregate, ...nextResult];
    }

    visitHoleExpression = (ctx: HoleExpressionContext): HoleLocation[] => {
        const startToken = ctx.start; // The first '?'
        const stopToken = ctx.stop;   // The second '?' (if they are separate tokens)

        if (startToken === null || stopToken === null ) {
            return []
        }

        return [{
            line: startToken.line - 1, // VS Code zero-based
            character: startToken.column,
            // Calculate length based on the full range of the expression
            length: stopToken.stop - startToken.start + 1
        }];
    }
}