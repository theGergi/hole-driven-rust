import { RustParserListener } from './parser/RustParserListener';
import {
    PathExpression_Context,
    BlockExpressionContext,
    Function_Context,
    CallExpressionContext,
    PathExpressionContext,
    LiteralExpression_Context,
    LetStatementContext,
    AssignmentExpressionContext,
    BorrowExpressionContext,
} from './parser/RustParser';
import { ParseTree, ParserRuleContext } from 'antlr4ng';

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

    // ============= Function Declaration Handling =============

    enterFunction_ = (ctx: Function_Context): void => {
        const funcName = ctx.identifier()?.getText() ?? 'unknown';
        const funcId = `func_${funcName}`;
        this.pushBlock(funcId);
    };

    exitFunction_ = (ctx: Function_Context): void => {
        this.popBlock();
    };

    // ============= Path Expression Handling (Variable/Function References) =============

    exitPathExpression_ = (ctx: PathExpression_Context): void => {
        console.log("path expression")
        console.log(ctx.getText())
        console.log(ctx.parent!.getText())
        console.log(ctx.parent)
        
        const valueText = ctx.getText();
        const line = this.getLine(ctx);

        // Only record if this is a simple path expression (variable or function name)
        // Skip qualified paths that contain "::"
        if (!valueText.includes('::')) {
            this.recordUsage(valueText, line);
        }
    };

    // ============= Let Statement Handling (Variable Declaration) =============

    enterLetStatement = (ctx: LetStatementContext): void => {
        // Let statements declare variables but may use existing values in initialization
        // The expressions in the let statement will be visited separately
    };

    // ============= Assignment Expression Handling =============

    enterAssignmentExpression = (ctx: AssignmentExpressionContext): void => {
        // Assignment expressions reference both the target and the assigned value
        // Both will be handled by path expression visitors
    };

    // ============= Helper Methods for Graph Analysis =============

    /**
     * Group usages by parent block
     */
    public getUsagesByBlockScope(): Map<BlockScope, ValueUsage[]> {
        const grouped = new Map<BlockScope, ValueUsage[]>();

        for (const usage of this.usages) {
            if (!grouped.has(usage.parent)) {
                grouped.set(usage.parent, []);
            }
            grouped.get(usage.parent)!.push(usage);
        }

        return grouped;
    }

    /**
     * Group usages by value name
     */
    public getUsagesByName(): Map<string, ValueUsage[]> {
        const grouped = new Map<string, ValueUsage[]>();

        for (const usage of this.usages) {
            if (!grouped.has(usage.name)) {
                grouped.set(usage.name, []);
            }
            grouped.get(usage.name)!.push(usage);
        }

        return grouped;
    }


    public isVariableFree(variableName: string, blockId: string, line: number): boolean {
        const usagesInBlock = this.getUsagesInBlock(blockId);
        const parentBlock = this.allBlocks.find(block => block.id === blockId)?.parentId;

        const freeInCurrentBlock = !usagesInBlock.some(usage => usage.name === variableName && usage.line > line);
        if (parentBlock) {
            const freeInAncestorBlock = this.isVariableFree(variableName, parentBlock, line)
            return freeInAncestorBlock && freeInCurrentBlock;
        }
        return freeInCurrentBlock;
    }

    /**
     * Get all usages for a specific parent block
     */
    public getUsagesInBlock(blockId: string): ValueUsage[] {
        return this.usages.filter(usage => usage.parent.id === blockId);
    }

    /**
     * Get all usages of a specific value
     */
    public getUsagesOfValue(valueName: string): ValueUsage[] {
        return this.usages.filter(usage => usage.name === valueName);
    }

    /**
     * Print usage graph in a readable format
     */
    public printUsageGraph(): string {
        let output = 'Value Usage Graph:\n';
        output += '==================\n\n';

        const usagesByParent = this.getUsagesByBlockScope();

        for (const [parent, usages] of usagesByParent) {
            output += `Block: ${parent}\n`;
            for (const usage of usages) {
                output += `  Line ${usage.line}: ${usage.name}\n`;
            }
            output += '\n';
        }

        return output;
    }
}
