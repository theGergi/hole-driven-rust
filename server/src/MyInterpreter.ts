import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, HoleExpressionContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree, Token } from 'antlr4ng';
import { get } from 'http';

export enum NodeType {
    ROOT = "ROOT",
    FUNCTION = "FUNCTION",
    INT = "INT",
    HOLE = "HOLE",
    UNKNOWN = "UNKNOWN",
}

export interface SourceLocation {
    line: number;
    column: number;
    offset: number;
    length: number;
}

export interface BaseNode {
    kind: string;
    location: SourceLocation;
    type?: NodeType; // Populated during type checking
}

export interface BlockExpressionNode extends BaseNode {
    kind: "Block";
    statements: BaseNode;
}

export interface FunctionDeclarationNode extends BaseNode {
    kind: "FunctionDeclarationNode";
    block: ExpressionNode;
}

export interface StatementsNode extends BaseNode {
    kind: "Statements";
    statements: BaseNode[];
    expression: ExpressionNode;
}

export interface BinaryExpressionNode extends BaseNode {
    kind: "BinaryExpression";
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface LiteralNode extends BaseNode {
    kind: "Literal";
    value: any;
}

export type ExpressionNode = BinaryExpressionNode | LiteralNode | BlockExpressionNode; // Add others as needed

function getLocation(ctx: ParserRuleContext): SourceLocation {
    const start = ctx.start!;
    const stop = ctx.stop!;
    
    return {
        line: start.line,
        column: start.column,
        offset: start.start,
        length: stop.stop - start.start + 1
    };
}


export default class MyInterpreter extends RustParserVisitor<BaseNode | null> {
    private typeStack: NodeType[] = [NodeType.ROOT];
    
    private get currentParentType(): NodeType {
        return this.typeStack[this.typeStack.length - 1];
    }

    visitCrate = (ctx: any): BaseNode => {
        console.log("Crate")
        const items = ctx.item();
        // Map over every item and visit it; filter out nulls if some items aren't implemented
        return items.map((item: ParseTree) => this.visit(item) as BaseNode).filter((n: ParseTree | null) => n !== null);
    };

    visitItem = (ctx: any): BaseNode | null => {
        console.log("Item")
        const visItem = ctx.visItem();
        if (visItem) {
            return this.visit(visItem) as BaseNode;
        }
        // Handle macroItem here if needed, otherwise return null
        return null; 
    };

    visitVisItem = (ctx: any): BaseNode | null => {
        console.log("Vis item")


        // This acts as a router. ANTLR provides methods for each possible child rule.
        if (ctx.function_()) {
            console.log(ctx.function_())
            return this.visit(ctx.function_()!);
        }
        console.log("hey")
        
        // Add other checks as you implement them (structs, modules, etc.)
        // if (ctx.struct_()) return this.visit(ctx.struct_()!);
        
        return null;
    };
    
    visitFunctionReturnType = (ctx: any): BaseNode | null => {
        console.log(ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier(0).NON_KEYWORD_IDENTIFIER())
        return null;
    }

    // visitType_ = (ctx: any): BaseNode | null => {
        //     console.log(ctx.type_())
    //     return null;
    // }

    visitFunction_ = (ctx: any): FunctionDeclarationNode => {
        console.log("Function");
        // console.log(ctx.functionReturnType())
        
        let type = NodeType.UNKNOWN;
        
        if (ctx.functionReturnType().type_().getText() === 'i32') {
            type = NodeType.INT;
        }

        this.typeStack.push(type);
        
        // 1. Get the function name
        // The identifier rule is a child of the function rule
        const name = ctx.identifier().getText();
        
        // 2. Handle the body (blockExpression or SEMI)
        const blockCtx = ctx.blockExpression();
        
        const blockNode = blockCtx ? this.visit(blockCtx) as BlockExpressionNode : {kind: "Literal", type: NodeType.UNKNOWN} as LiteralNode; 
        
        this.typeStack.pop()
        
        return {
            kind: "FunctionDeclarationNode",
            block: blockNode,
            location: getLocation(ctx),
            type: type
        };
    };

    visitBlockExpression = (ctx: any): BlockExpressionNode => {
        console.log("BlockExpression");
        
        const statementsNode = ctx.statements();
        
        const type = this.currentParentType
        
        if (statementsNode) {
            // Visit the statements rule
            
        }
        const visitedStatements = statementsNode ? this.visit(statementsNode) as BaseNode : {kind: "Literal", type: NodeType.UNKNOWN } as LiteralNode;
        
        return {
            kind: "Block",
            statements: visitedStatements,
            location: getLocation(ctx),
            type: type
        };
    };
    
    visitStatements = (ctx: any): StatementsNode => {
        console.log("Statements");
        const nodes: BaseNode[] = [];
        
        const type = this.currentParentType

        // 1. Visit all individual 'statement' children
        //
        
        // 2. Visit the optional trailing 'expression'
        const expr = ctx.expression();
        const expressionNode = expr ? this.visit(expr) as ExpressionNode : {kind: "Literal", type: NodeType.UNKNOWN } as LiteralNode;

        return {
            kind: "Statements",
            statements: nodes,
            expression: expressionNode,
            location: getLocation(ctx),
            type: type
        }
    };

    visitArithmeticOrLogicalExpression = (ctx: ArithmeticOrLogicalExpressionContext): ExpressionNode => {
        console.log("ArithmeticOrLogicalExpression")
        // 1. Extract the operator text
        const operator = ctx.getChild(1)?.getText(); // The operator is the middle child
        
        const leftChild = ctx.expression(0)
        const rightChild = ctx.expression(1)

        if (!leftChild || !rightChild) {
            throw new Error("Invalid binary expression: missing operands");
        }
        
        // 2. Recursively build the left and right AST branches
        const left = this.visit(leftChild) as ExpressionNode;
        const right = this.visit(rightChild) as ExpressionNode;

        let type;

        if (left.type === NodeType.HOLE || right.type === NodeType.HOLE) {
            type = NodeType.HOLE;
        } else if (left.type === right.type) {
            type = left.type;
        }

        // 3. Return the structured AST node
        return {
            kind: "BinaryExpression",
            operator: operator as any,
            left: left,
            right: right,
            location: getLocation(ctx), // Using the helper from the previous step
            type: type
        };
    };

    visitLiteralExpression = (ctx: any): LiteralNode => {
        console.log("Literal Expression")
        // 1. Identify which token is present
        if (ctx.INTEGER_LITERAL()) {
            return {
                kind: "Literal",
                value: parseInt(ctx.INTEGER_LITERAL()!.getText(), 10),
                type: NodeType.INT,
                location: getLocation(ctx)
            };
        }

        // if (ctx.FLOAT_LITERAL()) {
        //     return {
        //         kind: "Literal",
        //         value: parseFloat(ctx.FLOAT_LITERAL()!.getText()),
        //         type: "float",
        //         location: getLocation(ctx)
        //     };
        // }

        // if (ctx.STRING_LITERAL() || ctx.RAW_STRING_LITERAL()) {
        //     const rawValue = (ctx.STRING_LITERAL() ?? ctx.RAW_STRING_LITERAL())!.getText();
        //     return {
        //         kind: "Literal",
        //         // You might want a helper to strip quotes: rawValue.slice(1, -1)
        //         value: rawValue, 
        //         type: "string",
        //         location: getLocation(ctx)
        //     };
        // }

        // if (ctx.CHAR_LITERAL()) {
        //     return {
        //         kind: "Literal",
        //         value: ctx.CHAR_LITERAL()!.getText(),
        //         type: "char",
        //         location: getLocation(ctx)
        //     };
        // }

        // Default fallback or handling for Byte literals
        return {
            kind: "Literal",
            value: ctx.getText(),
            type: NodeType.UNKNOWN,
            location: getLocation(ctx)
        };

    };

    visitHoleExpression = (ctx: any): LiteralNode => {
        console.log("Hole expression")
        console.log("Type shold be", this.currentParentType)
        return {
            kind: "Literal",
            value: ctx.getText(),
            type: NodeType.HOLE,
            location: getLocation(ctx)
        };
    }

// protected defaultResult(): BaseNode {
    //     throw new Error("Node not implemented");
    // }
}