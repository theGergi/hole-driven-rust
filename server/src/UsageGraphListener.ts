import { RustParserListener } from './parser/RustParserListener';
import {
    PathExpression_Context,
    BlockExpressionContext
} from './parser/RustParser';
import { ParserRuleContext } from 'antlr4ng';

export interface BlockScope {
    id: string;          // Unique identifier for the block
    parentId: string | null; // Parent block ID (null for global scope)
    type: 'function' | 'block'; // Type of block (function or generic block)
}

/**
 * Represents a usage of a value in the code
 */
export interface ValueUsage {
    parent: BlockScope;      // Block identifier (scope)
    line: number;        // Line number where value is used
    name: string;        // Name of the value (variable or function)
}

/**
 * Listener that constructs a graph of value usages in the form (parent, line, name)
 * Tracks where values (variables, functions) are referenced in the code
 */
export class UsageGraphListener extends RustParserListener {
    private usages: ValueUsage[] = [];
    private allBlocks: BlockScope[] = []; // List of all blocks for reference
    private blockStack: BlockScope[] = [{ id: 'global', parentId: null, type: 'block' }]; // Stack to track nested blocks
    private blockCounter: number = 0;          // Counter to generate unique block IDs

    /**
     * Get all recorded value usages
     */
    public getUsages(): ValueUsage[] {
        return this.usages;
    }

    /**
     * Get current block context
     */
    private getCurrentBlock(): BlockScope {
        return this.blockStack[this.blockStack.length - 1];
    }

    /**
     * Get line number from a parser context
     */
    private getLine(ctx: ParserRuleContext | undefined): number {
        if (!ctx || !ctx.start) {
            return -1;
        }
        return ctx.start.line;
    }

    /**
     * Push a new block onto the stack
     */
    private pushBlock(blockId: string): void {
        this.allBlocks.push({ id: blockId, parentId: this.getCurrentBlock().id, type: 'block' });
        this.blockStack.push({ id: blockId, parentId: this.getCurrentBlock().id, type: 'block' });
    }

    /**
     * Pop a block from the stack
     */
    private popBlock(): void {
        if (this.blockStack.length > 1) {
            this.blockStack.pop();
        }
    }

    /**
     * Record a value usage
     */
    private recordUsage(name: string, line: number): void {
        // Don't record if line is invalid
        if (line > 0) {
            this.usages.push({
                parent: this.getCurrentBlock(),
                line: line,
                name: name,
            });
        }
    }

    // ============= Block Expression Handling =============

    enterBlockExpression = (ctx: BlockExpressionContext): void => {
        const blockId = `block_${this.blockCounter++}`;
        this.pushBlock(blockId);
    };

    exitBlockExpression = (ctx: BlockExpressionContext): void => {
        this.popBlock();
    };

    // ============= Path Expression Handling (Variable/Function References) =============

    exitPathExpression_ = (ctx: PathExpression_Context): void => {
        const valueText = ctx.getText();
        const line = this.getLine(ctx);

        // Only record if this is a simple path expression (variable or function name)
        // Skip qualified paths that contain "::"
        if (!valueText.includes('::')) {
            this.recordUsage(valueText, line);
        }
    };

    public isVariableFree(variableName: string, blockId: string, line: number): boolean {
        const usagesInBlock = this.usages.filter(usage => usage.parent.id === blockId);
        const parentBlock = this.allBlocks.find(block => block.id === blockId)?.parentId;

        const freeInCurrentBlock = !usagesInBlock.some(usage => usage.name === variableName && usage.line > line);
        if (parentBlock) {
            const freeInAncestorBlock = this.isVariableFree(variableName, parentBlock, line)
            return freeInAncestorBlock && freeInCurrentBlock;
        }
        return freeInCurrentBlock;
    }
}
