import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, CallExpressionContext, HoleExpressionContext, PathExpression_Context, PathExpressionContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree, Token } from 'antlr4ng';
import { get } from 'http';
import { Func } from 'mocha';
import { isPrimitive } from 'util';

export enum ValType {
    ROOT = "ROOT",
    FUNCTION = "FUNCTION",
    INT = "i32",
    STRING = "string",
    HOLE = "HOLE",
    UNKNOWN = "UNKNOWN",
}

export enum Borrow {
    BFree,
    BMut,
    BImmut
}

export interface Type {
    valType: ValType;
    primitive: boolean;
    mutable: boolean;
    consumed: boolean;
    borrows: Borrow;
    owner: Variable;
}

export interface Suggestion {
    suggestionType: string;
    suggestion: any;
}

export interface Variable {
    name: string;
    location: SourceLocation;
    type: Type;
}

export interface Function {
    name: string;
    location: SourceLocation;
    type?: ValType;
    params: FunctionParam[];
}
export interface FunctionParam {
    name: string;
    type?: ValType;
}

export interface Hole {
    location: SourceLocation;
    type: ValType;
    suggestions: Suggestion[]
}

export interface SourceLocation {
    line: number;
    column: number;
    length: number;
}
export const getSourceLocationKey = (loc: SourceLocation): string => {
    return `${loc.line}:${loc.column}:${loc.length}`;
};

export interface BaseNode {
    kind: string;
    location: SourceLocation;
    type?: ValType; // Populated during type checking
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

export interface VariableNode extends BaseNode {
    kind: "Variable";
    name: string;
}



export type ExpressionNode = BinaryExpressionNode | LiteralNode | BlockExpressionNode; // Add others as needed

function getLocation(ctx: ParserRuleContext): SourceLocation {
    const start = ctx.start!;
    const stop = ctx.stop!;
    
    return {
        line: start.line,
        column: start.column,
        length: stop.stop - start.start + 1
    };
}

function toType(valType: ValType, variable: Variable): Type {
    let primitive = false;
    
    if (valType == ValType.INT) {
        primitive = true;
    }

    return {
        valType: valType,
        primitive: primitive,
        mutable: false,
        consumed: false,
        borrows: Borrow.BFree,
        owner: variable
    }
}

function isVariable(variable: BaseNode) {
    if ("name" in variable && "location" in variable && ! ("params" in variable)) {

    }
}

export default class MyInterpreter extends RustParserVisitor<BaseNode | null> {
    private typeStack: ValType[] = [ValType.ROOT];
    private variables: Variable[] = [];
    private functions: Function[] = [];
    private holes: Hole[] = [];
    
    getBoundVariable(variableName: string): Variable {
        const variable = this.variables.find(variable => (variable.name === variableName))

        if(variable) {
            return variable;
        } else {
            throw Error("Variable not bound")
        }
    }

    getBoundFunction(functionName: string): Function {
        const function_ = this.functions.find(function_ => (function_.name === functionName))

        if(function_) {
            return function_;
        } else {
            throw Error("Function not bound")
        }
    }

    borrow(variableName: string, mutable: boolean) {
        const variable = this.getBoundVariable(variableName);

        if (variable.type.primitive) {
            return
        }

        if (variable.type?.borrows === Borrow.BFree) {
            variable.type.borrows = mutable ? Borrow.BMut : Borrow.BImmut
        } else if (variable.type?.borrows === Borrow.BMut) {
            throw Error("Cannot borrow, already mutably borrowed")
        } else {
            if (mutable) {
                throw Error("Cannot mutably borrow, already immutably borrowed")
            }
        }
    }

    consume(variableName: string) {
        const variable = this.getBoundVariable(variableName)
        if (variable.type.primitive) {
            return
        }
        if (variable.type.consumed) {
            throw Error("Cannot consume already consumed variable")
        }
        console.log("Consumed", variableName)
        variable.type.consumed = true
    }

    private get currentParentType(): ValType {
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

    visitAssignmentExpression = (ctx: any): BaseNode | null => {
        const variableName = ctx.expression(0).getText();
        const expression = ctx.expression(1);

        console.log("3333333333333333333333")
        console.log(variableName)

        const variable = this.getBoundVariable(variableName)

        if (!variable.type.mutable) {
            throw Error("Cannot modify immutable variable", variableName)
        }

        let inferedType = ValType.UNKNOWN;
        if (expression) {
            inferedType = this.visit(expression)?.type as ValType;
        }

        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }

        variable.location = getLocation(ctx);

        return null
    }

    visitLetStatement = (ctx: any): BaseNode | null => {
        console.log("Let statement")
        const variableName = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().identifier().getText();
        const mutable = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().KW_MUT() != null;
        const declaredType = this.parseType(ctx.type_()?.getText());
        const expression = ctx.expression();

        let inferedType = ValType.UNKNOWN;

        if (expression) {
            inferedType = this.visit(expression)?.type as ValType;
        }

        if (inferedType !== ValType.UNKNOWN && declaredType !== ValType.UNKNOWN && declaredType !== inferedType) {
            throw new Error("Declared type is different from infered type");
        }

        if (inferedType === ValType.UNKNOWN && declaredType === ValType.UNKNOWN) {
            throw new Error("No type");
        }

        const valType = declaredType !== ValType.UNKNOWN ? declaredType : inferedType;

        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }

        const type = toType(valType, variableName);
        type.mutable = mutable;

        this.variables.push({name: variableName, type: type, location: getLocation(ctx)})
        console.log("44444444444444444444")
        console.log(this.variables)
        return null;
    }

    visitPathExpression = (ctx: any): BaseNode | null => {
        console.log(ctx.getText())
        if(ctx.parent.parent instanceof CallExpressionContext) {
            const type = this.getBoundFunction(ctx.getText()).type
            return {kind: "Function", type: type, location: getLocation(ctx)}
        } else {
            const type = this.getBoundVariable(ctx.getText()).type.valType
            return {kind: "Variable", type: type, location: getLocation(ctx)}
        }

    }

    visitVisItem = (ctx: any): BaseNode | null => {
        console.log("Vis item")


        // This acts as a router. ANTLR provides methods for each possible child rule.
        if (ctx.function_()) {
            // console.log(ctx.function_())
            return this.visit(ctx.function_()!);
        }
        
        // Add other checks as you implement them (structs, modules, etc.)
        // if (ctx.struct_()) return this.visit(ctx.struct_()!);
        
        return null;
    };
    
    visitFunctionReturnType = (ctx: any): BaseNode | null => {
        // console.log(ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier(0).NON_KEYWORD_IDENTIFIER())
        return null;
    }

    // visitType_ = (ctx: any): BaseNode | null => {
        //     console.log(ctx.type_())
    //     return null;
    // }
    parseType = (typeString: string): ValType => {
        if (typeString === 'i32') {
            return ValType.INT;
        }
        if (typeString === 'string') {
            return ValType.STRING;
        }
        return ValType.UNKNOWN;
    }

    visitFunction_ = (ctx: any): FunctionDeclarationNode => {
        console.log("Function");
        // console.log(ctx.functionReturnType())
        
        let type = this.parseType(ctx.functionReturnType().type_().getText());

        this.typeStack.push(type);
        
        // 1. Get the function name
        // The identifier rule is a child of the function rule
        const name = ctx.identifier().getText();
        
        const params = ctx.functionParameters()?.functionParam();

        const paramsParsed = params?.map((param: any) => {

            return {
                name: param.functionParamPattern().pattern().getText(), 
                type: this.parseType(param.functionParamPattern().type_().getText())
            }
        })

        this.functions.push({
            name: name,
            location: getLocation(ctx),
            type: type,
            params: paramsParsed || []
        })

        // 2. Handle the body (blockExpression or SEMI)
        const blockCtx = ctx.blockExpression();
        
        const blockNode = blockCtx ? this.visit(blockCtx) as BlockExpressionNode : {kind: "Literal", type: ValType.UNKNOWN} as LiteralNode; 
        
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
        const visitedStatements = statementsNode ? this.visit(statementsNode) as BaseNode : {kind: "Literal", type: ValType.UNKNOWN } as LiteralNode;
        
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
        const statements = ctx.statement()
        statements.forEach((statement: ParseTree) => {
            this.visit(statement)
        });
        
        // 2. Visit the optional trailing 'expression'
        const expr = ctx.expression();
        const expressionNode = expr ? this.visit(expr) as ExpressionNode : {kind: "Literal", type: ValType.UNKNOWN } as LiteralNode;

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
        console.log(leftChild)
        let type;

        if (left.type === ValType.HOLE || right.type === ValType.HOLE) {
            type = ValType.HOLE;
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
                type: ValType.INT,
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

        if (ctx.STRING_LITERAL() || ctx.RAW_STRING_LITERAL()) {
            const rawValue = (ctx.STRING_LITERAL() ?? ctx.RAW_STRING_LITERAL())!.getText();
            return {
                kind: "Literal",
                // You might want a helper to strip quotes: rawValue.slice(1, -1)
                value: rawValue, 
                type: ValType.STRING,
                location: getLocation(ctx)
            };
        }

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
            type: ValType.UNKNOWN,
            location: getLocation(ctx)
        };

    };

    visitHoleExpression = (ctx: any): LiteralNode => {
        console.log("Hole expression")
        
        const location = getLocation(ctx)
        const type = this.currentParentType;

        console.log("Type should be", type)
        const hole = {location:location, type: type, suggestions: []}
        this.generateHole(hole)

        console.log(hole)
        return {
            kind: "Literal",
            value: ctx.getText(),
            type: ValType.HOLE,
            location: location
        };
    }

    public getFinalResult(): Map<string, Hole> {
        const holes = this.holes;
        const variables = this.variables;
        const functions = this.functions;

        console.log("Variables:")
        console.log(variables)

        console.log("Holes:")
        console.log(holes)

        console.log("Functions:")
        console.log(functions)
        let holeSuggestions = new Map<string, Hole>();
        
        holes.forEach((hole: Hole) => {
            const key = getSourceLocationKey(hole.location);

            // variables.forEach((variable: Variable) => {
            //     if (variable.type && variable.type.valType === hole.type && !variable.type.consumed) {
            //         let vars = holeSuggestions.get(key)
            //         if (!vars) {
            //             vars = []
            //             holeSuggestions.set(key, vars)
            //         }
            //         vars.push({suggestionType: 'variable', suggestion: variable});
            //     }
            // });
            // functions.forEach((func: Function) => {
            //     if (func.type === hole.type) {
            //         let funcs = holeSuggestions.get(key)
            //         if (!funcs) {
            //             funcs = []
            //             holeSuggestions.set(key, funcs)
            //         }
            //         funcs.push({suggestionType: 'function', suggestion: func});
            //     }
            // })
            holeSuggestions.set(key, hole)
        });
        console.log("Suggestions:")
        console.log(holeSuggestions)
        return holeSuggestions;
    }

    public generateHole(hole: Hole) {
        const variables = this.variables;
        const functions = this.functions;

        console.log("Variables:")
        console.log(variables)

        console.log("Functions:")
        console.log(functions)
        let holeSuggestions = [] as Suggestion[];
        
        const key = getSourceLocationKey(hole.location);

        variables.forEach((variable: Variable) => {
            if (variable.type && variable.type.valType === hole.type && !variable.type.consumed) {
                holeSuggestions.push({suggestionType: 'variable', suggestion: variable});
            }
        });
        functions.forEach((func: Function) => {
            if (func.type === hole.type) {
                holeSuggestions.push({suggestionType: 'function', suggestion: func});
            }
        })

        console.log("Suggestions:")
        console.log(holeSuggestions)
        hole.suggestions = holeSuggestions
        this.holes.push(hole)
    }

// protected defaultResult(): BaseNode {
    //     throw new Error("Node not implemented");
    // }
}