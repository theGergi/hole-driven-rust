import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, CallExpressionContext, HoleExpressionContext, PathExpression_Context, PathExpressionContext, BorrowExpressionContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree, Token } from 'antlr4ng';
import { get } from 'http';
import { Func } from 'mocha';
import { isPrimitive } from 'util';
import { TraceValues } from 'vscode-languageserver';
import { isDeepStrictEqual } from 'util';
import { UsageGraphListener, ValueUsage } from './UsageGraphListener';

export enum ValType {
    ROOT = "ROOT",
    FUNCTION = "FUNCTION",
    INT = "i32",
    STRING = "string",
    HOLE = "HOLE",
    UNKNOWN = "UNKNOWN",
    VECTOR = "Vec",
    REFERENCE = "reference"
}

export enum Borrow {
    BFree,
    BMut,
    BImmut
}

export interface Type {
    elementType?: ValType; // For vectors and references
    valType: ValType;
    primitive: boolean;
    mutable: boolean | null;
    mutableReference?: boolean; // Only for references, indicates if the reference itself is mutable (e.g., &mut T vs &T)
    consumed: boolean;
    borrows: Borrow;
    owner?: Variable;
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
    type?: Type;
    params: FunctionParam[];
}
export interface FunctionParam {
    name: string;
    type?: Type;
}

export interface Hole {
    location: SourceLocation;
    type: Type;
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
    type?: Type; // Populated during type checking
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

export interface BorrowExpressionNode extends BaseNode {
    kind: "BorrowExpression";
    mutable: boolean;
    expression: ExpressionNode;
}

export type ExpressionNode = BinaryExpressionNode | LiteralNode | BlockExpressionNode | BorrowExpressionNode; // Add others as needed

function getLocation(ctx: ParserRuleContext): SourceLocation {
    const start = ctx.start!;
    const stop = ctx.stop!;
    
    return {
        line: start.line,
        column: start.column,
        length: stop.stop - start.start + 1
    };
}

export function toType(overrides: Partial<Type> & { valType: ValType }, variable?: Variable): Type {
    let primitive = false;
    
    if (overrides.valType === ValType.INT) {
        primitive = true;
    }

    return {
        primitive: primitive,
        mutable: false,
        consumed: false,
        borrows: Borrow.BFree,
        ...overrides
    }
}

export function canBeAssigned(assignee: Type, assigned: Type): boolean {

    if (assignee.mutable && !assigned.mutable) {
        return false;
    }
    
    if (assignee.valType === ValType.UNKNOWN) {
        return true;
    }
    
    if (assignee.valType === assigned.valType) {
        if (assignee.valType === ValType.VECTOR ) {
            return assignee.elementType === assigned.elementType;
        } else if (assignee.valType === ValType.REFERENCE) {
            if (assignee.mutableReference && !assigned.mutableReference) {
                return false;
            }
            return assignee.elementType === assigned.elementType;
        }
        return true;
    }
    return false;
}

function isVariable(variable: BaseNode) {
    if ("name" in variable && "location" in variable && ! ("params" in variable)) {

    }
}

export default class MyInterpreter extends RustParserVisitor<BaseNode | null> {
    private typeStack: Type[] = [toType({valType: ValType.ROOT})];
    private variables: Variable[] = [];
    private functions: Function[] = [];
    private holes: Hole[] = [];
    
    private blockStack: string[] = ['global']; // Stack to track nested blocks
    private blockCounter: number = 0;          // Counter to generate unique block IDs

    private usageListener: UsageGraphListener;

    constructor(usageListener: UsageGraphListener) {
        super();
        this.usageListener = usageListener;
    }

    saveState() {
        return { variables: structuredClone(this.variables) }
    }

    loadState(state: any) {
        this.variables = state.variables;
    }

    /**
     * Get current block context
     */
    private getCurrentBlock(): string {
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
        this.blockStack.push(blockId);
    }

    /**
     * Pop a block from the stack
     */
    private popBlock(): void {
        if (this.blockStack.length > 1) {
            this.blockStack.pop();
        }
    }


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

    borrow(variableName: string, mutable: boolean): Variable {
        const variable = this.getBoundVariable(variableName);

        if (variable.type?.borrows === Borrow.BFree) {
            variable.type.borrows = mutable ? Borrow.BMut : Borrow.BImmut
        } else if (variable.type?.borrows === Borrow.BMut) {
            throw Error("Cannot borrow, already mutably borrowed")
        } else {
            if (mutable) {
                throw Error("Cannot mutably borrow, already immutably borrowed")
            }
        }
        return variable;
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

    private get currentParentType(): Type {
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
        console.log("Assignment expression")

        const variableName = ctx.expression(0).getText();
        const expression = ctx.expression(1);

        const variable = this.getBoundVariable(variableName)

        if (!variable.type.mutable) {
            throw Error("Cannot modify immutable variable", variableName)
        }

        let inferedType: Type = toType({valType: ValType.UNKNOWN});
        if (expression) {
            inferedType = this.visit(expression)?.type as Type;
        }

        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }

        variable.location = getLocation(ctx);

        return null
    }

    visitMacroInvocation = (ctx: any): BaseNode | null => {
        console.log("Macro invocation")
        
        if (ctx.simplePath().getText() === "vec") {
            let type : Type | undefined = undefined;
            const tokens = ctx.delimTokenTree().tokenTree(0).tokenTreeToken();

            if (!tokens.every((val:any, i:number) => (i % 2 === 1 ? val.getText() === ',' : true))) {
                throw Error("Only simple vec macros with commas are supported")
            }

            tokens.forEach((token: any, i: number) => {
                if (i % 2 === 0) {
                    const elType = this.visit(token)!.type!.valType;
                    if (type === undefined) {
                        type = toType({valType: ValType.VECTOR, elementType: elType});
                    } else if (type.elementType !== elType) {
                        throw Error("All elements in vec must be of same type")
                    }
                }
            })

            return {
                kind: "MacroInvocation",
                type: type,
                location: getLocation(ctx)
            }
        }

        return null;
    }

    visitLetStatement = (ctx: any): BaseNode | null => {
        console.log("Let statement")
        const variableName = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().identifier().getText();
        const mutable = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().KW_MUT() != null;
        const declaredType = this.parseType(ctx.type_()?.getText());
        const expression = ctx.expression();
        let recordVar = true;

        this.typeStack.push(declaredType);

        let inferedType: Type = toType({valType: ValType.UNKNOWN});

        if (expression) {
            inferedType = toType(this.visit(expression)?.type as Type);
        }
        if (inferedType.valType === ValType.HOLE) {
            recordVar = false;
        }

        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }

        this.typeStack.pop();
        
        if (inferedType.valType === ValType.UNKNOWN && declaredType.valType === ValType.UNKNOWN) {
            throw new Error("No type");
        } else if (inferedType.valType === ValType.HOLE && declaredType.valType !== ValType.UNKNOWN) {
            inferedType = declaredType;
        } else if (inferedType.valType !== ValType.UNKNOWN && declaredType.valType !== ValType.UNKNOWN) {
            if (declaredType.valType !== inferedType.valType) {
                throw new Error("Declared type is different from infered type: " + declaredType.valType + " vs " + inferedType.valType);
            }
            if (declaredType.valType === ValType.VECTOR || declaredType.valType === ValType.REFERENCE) {
                if (inferedType.elementType === ValType.UNKNOWN && declaredType.elementType === ValType.UNKNOWN) {
                    throw new Error("No type");
                } else if (inferedType.elementType === ValType.HOLE && declaredType.elementType !== ValType.UNKNOWN) {
                    inferedType = declaredType;
                } else if (inferedType.elementType !== ValType.UNKNOWN && declaredType.elementType !== ValType.UNKNOWN) {
                    if (declaredType.elementType !== inferedType.elementType) {
                        throw new Error("Declared subtype is different from infered type: " + declaredType.elementType + " vs " + inferedType.elementType);
                    }
                }
            }
            
            
        }

        if (recordVar) {

            let valType = inferedType;
            if ( inferedType.valType === ValType.UNKNOWN || inferedType.elementType === ValType.UNKNOWN ) {
                valType = declaredType;
            }
            console.log(valType, inferedType, declaredType)
            // const valType = declaredType.valType !== ValType.UNKNOWN ? declaredType : inferedType;
            
            const type = toType(valType);
            type.mutable = mutable;

            console.log(type)
            const variable: Variable = {name: variableName, type: type, location: getLocation(ctx)};

            this.variables.push(variable)
        }
        return null;
    }

    visitCallExpression = (ctx: any): BaseNode | null => {

        const func = this.getBoundFunction(ctx.expression().getText());
        console.log("Function call:", func.name)

        ctx.callParams().expression().forEach((expr: any, i: number) => {
            const otherType = func.params[i].type;

            this.typeStack.push(otherType!)
            const type = this.visit(expr)?.type;

            if (expr instanceof PathExpressionContext) {
                this.consume(expr.getText())
            }
            this.typeStack.pop()
        })

        return { kind: "Function", type: func.type, location: getLocation(ctx) };
    }

    visitPathExpression = (ctx: any): BaseNode | VariableNode | null => {
        console.log("Path expression")
        if(ctx.parent.parent instanceof CallExpressionContext) { // Kinda useless now
            const func = this.getBoundFunction(ctx.getText());
            console.log("Function call:", func.name)
            return { kind: "Function", type: func.type, location: getLocation(ctx) };
        } else {
            const variable = this.getBoundVariable(ctx.getText());
            console.log("Variable:", variable.name)
            return { kind: "Variable", name: variable.name, type: variable.type, location: getLocation(ctx) };
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
    
    // visitFunctionReturnType = (ctx: any): BaseNode | null => {
    //     con
    //     // console.log(ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier(0).NON_KEYWORD_IDENTIFIER())
    //     return null;
    // }

    // visitType_ = (ctx: any): BaseNode | null => {
        //     console.log(ctx.type_())
    //     return null;
    // }
    parseType = (typeString: string): Type => {
        if (!typeString) {
            return toType({valType: ValType.UNKNOWN});
        }

        if (typeString === 'i32') {
            return toType({valType: ValType.INT});
        }
        if (typeString === 'string') {
            return toType({valType: ValType.STRING});
        }
        const vecMatch = typeString.match(/^Vec<(.+)>$/);

        if (vecMatch) {
            const elementType = this.parseType(vecMatch[1]); 
            return toType({valType: ValType.VECTOR, elementType: elementType.valType});
        }
        const refMatch = typeString.match(/^(&)?\s*(mut)?\s*([a-zA-Z_][a-zA-Z0-9_]*)$/);
        console.log("Parsing type:", typeString)
        if (refMatch) {

            const mutableReference = refMatch[2] === 'mut' ? true : false;
            const elementType = this.parseType(refMatch[3]);

            return toType({valType: ValType.REFERENCE, elementType: elementType.valType,mutableReference: mutableReference, mutable: null});
        }
        return toType({valType: ValType.UNKNOWN});
    }

    visitFunction_ = (ctx: any): FunctionDeclarationNode => {
        console.log("Function");

        const funcName = ctx.identifier()?.getText() ?? 'unknown';
        const funcId = `func_${funcName}`;
        this.pushBlock(funcId);

        let type = this.parseType(ctx.functionReturnType()?.type_().getText());

        this.typeStack.push(type);
        
        // 1. Get the function name
        // The identifier rule is a child of the function rule
        const name = ctx.identifier().getText();
        
        const params = ctx.functionParameters()?.functionParam();

        const paramsParsed = params?.map((param: any) => {
            const pattern = param.functionParamPattern().pattern().patternNoTopAlt(0).patternWithoutRange().identifierPattern();
            const paramName = pattern.identifier().getText();
            const mutable = pattern.KW_MUT() != null;
            const type = this.parseType(param.functionParamPattern().type_().getText())
            type.mutable = mutable;

            const variable: Variable = {name: paramName, type: type, location: getLocation(param)};

            this.variables.push(variable)
            
            return {
                name: paramName, 
                type: type
            }
        })

        this.functions.push({
            name: name,
            location: getLocation(ctx),
            type: type,
            params: paramsParsed || []
        })

        const blockCtx = ctx.blockExpression();
        
        const blockNode = blockCtx ? this.visit(blockCtx) as BlockExpressionNode : { kind: "Literal", value: null, type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) } as LiteralNode; 
        
        this.typeStack.pop()
        
        this.variables = []; // Clear variables after function scope ends

        this.pushBlock(funcId);

        return {
            kind: "FunctionDeclarationNode",
            block: blockNode,
            location: getLocation(ctx),
            type: type
        };
    };

    visitBlockExpression = (ctx: any): BlockExpressionNode => {
        console.log("BlockExpression");

        const blockId = `block_${this.blockCounter++}`;
        this.pushBlock(blockId);
        
        const statementsNode = ctx.statements();
        
        const type = this.currentParentType

        const currentState = this.saveState()

        const visitedStatements = statementsNode ? this.visit(statementsNode) as BaseNode : { kind: "Literal", value: null, type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) } as LiteralNode;

        this.loadState(currentState)

        this.popBlock();

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
        
        const type = toType({valType: ValType.UNKNOWN});
        this.typeStack.push(type);

        // 1. Visit all individual 'statement' children
        const statements = ctx.statement()
        statements.forEach((statement: ParseTree) => {
            this.visit(statement)
        });
        
        // 2. Visit the optional trailing 'expression'
        const expr = ctx.expression();
        const expressionNode = expr ? this.visit(expr) as ExpressionNode : { kind: "Literal", value: null, type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) } as LiteralNode;

        this.typeStack.pop()
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

        let type: Type;

        if (left.type?.valType === ValType.HOLE || right.type?.valType === ValType.HOLE) {
            type = toType({valType: ValType.HOLE});
        } else if (left.type?.valType === right.type?.valType) {
            type = left.type!;
        } else {
            type = toType({valType: ValType.UNKNOWN});
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

    visitBorrowExpression = (ctx: BorrowExpressionContext): BorrowExpressionNode => {
        console.log("BorrowExpression");
        const mutable = ctx.KW_MUT() != null;
        const exprCtx = ctx.expression();
        
        let owner = undefined;

        // If borrowing a variable, mark it as borrowed
        if (exprCtx instanceof PathExpression_Context) {
            const varName = exprCtx.getText();
            owner = this.borrow(varName, mutable);
        }
        console.log(owner)
        
        const expr = this.visit(exprCtx) as ExpressionNode;
        
        const type: Type = {
            valType: ValType.REFERENCE,
            elementType: expr.type!.valType,
            primitive: false,
            mutable: null,
            consumed: false,
            borrows: Borrow.BFree,
            owner: owner
        };

        return {
            kind: "BorrowExpression",
            mutable: mutable,
            expression: expr,
            location: getLocation(ctx),
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
                type: toType({valType: ValType.INT}),
                location: getLocation(ctx)
            };
        }

        // if (ctx.FLOAT_LITERAL()) {
        //     return {
        //         valType: "Literal",
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
                type: toType({valType: ValType.STRING}),
                location: getLocation(ctx)
            };
        }

        // if (ctx.CHAR_LITERAL()) {
        //     return {
        //         valType: "Literal",
        //         value: ctx.CHAR_LITERAL()!.getText(),
        //         type: "char",
        //         location: getLocation(ctx)
        //     };
        // }

        // Default fallback or handling for Byte literals
        return {
            kind: "Literal",
            value: ctx.getText(),
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };

    };

    visitHoleExpression = (ctx: any): LiteralNode => {
        console.log("Hole expression")

        const location = getLocation(ctx)
        const type = this.currentParentType;
        console.log("Alleged type:", type)

        const hole = {location:location, type: type, suggestions: []}
        this.generateHole(hole)

        return {
            kind: "Literal",
            value: ctx.getText(),
            type: toType({valType: ValType.HOLE}),
            location: location
        };
    }

    public generateHole(hole: Hole) {
        const variables = this.variables;
        const functions = this.functions;

        // console.log("Variables:")
        // console.log(variables)

        // console.log("Functions:")
        // console.log(functions)
        let holeSuggestions = [] as Suggestion[];
        

        variables.forEach((variable: Variable) => {
            if (variable.type && canBeAssigned(hole.type, variable.type) && !variable.type.consumed) {
                const borrows = this.variables.filter(v => v.type.owner === variable.type.owner && v !== variable.type.owner)
                // console.log("Checking variable:", variable.name)
                // console.log(variable.type.owner)
                // console.log(borrows)
                if (borrows.every(v => this.usageListener.isVariableFree(v.name, this.getCurrentBlock(), hole.location.line))) {
                    holeSuggestions.push({suggestionType: 'variable', suggestion: variable});
                }
            }
            if (hole.type.valType === ValType.REFERENCE && variable.type.valType === hole.type.elementType && !variable.type.consumed) {
                if (hole.type.mutableReference) {
                    if (variable.type.mutable) {
                        if (variable.type.borrows === Borrow.BFree) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&mut " + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, mutableReference: true}), location: variable.location}});
                        } else {
                            const borrows = this.variables.filter(v => v.type.owner === variable && v !== variable)

                            if (borrows.every(v => this.usageListener.isVariableFree(v.name, this.getCurrentBlock(), hole.location.line))) {
                                holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&mut " + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, mutableReference: true}), location: variable.location}});
                            }
                        }
                    }
                } else {
                    if (variable.type.borrows === Borrow.BFree || variable.type.borrows === Borrow.BImmut) {
                        holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&" + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType}), location: variable.location}});
                    } else {
                        const borrows = this.variables.filter(v => v.type.owner === variable && v !== variable)

                        if (borrows.every(v => this.usageListener.isVariableFree(v.name, this.getCurrentBlock(), hole.location.line))) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&mut " + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, mutableReference: true}), location: variable.location}});
                        }
                    }
                }
            }
        });
        functions.forEach((func: Function) => {
            if (func.type && canBeAssigned(hole.type, func.type)) {
                holeSuggestions.push({suggestionType: 'function', suggestion: func});
            }
        })

        // console.log("Suggestions:")
        // console.log(holeSuggestions)
        hole.suggestions = holeSuggestions
        this.holes.push(hole)
    }

    public getFinalResult() {
        const holes = this.holes;

        let holeSuggestions = new Map<string, Hole>();
        
        holes.forEach((hole: Hole) => {
            const key = getSourceLocationKey(hole.location);
            holeSuggestions.set(key, hole)
        });
        console.log("Suggestions:")
        console.log(holeSuggestions)
        return {holes: holeSuggestions, variables: this.variables, functions: this.functions} as any;
    }
}