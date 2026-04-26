import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, CallExpressionContext, PathExpression_Context, PathExpressionContext, BorrowExpressionContext, IdentifierContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree } from 'antlr4ng';
import { UsageGraphListener } from './UsageGraphListener';
import { ref } from 'process';

export enum ValType {
    ROOT = "ROOT",
    FUNCTION = "FUNCTION",
    INT = "integer",
    STRING = "string",
    HOLE = "HOLE",
    UNKNOWN = "UNKNOWN",
    VECTOR = "Vec",
    REFERENCE = "reference",
    STRUCT = "struct"
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
    structName?: string; // For struct types
    property?: boolean; // Marked when a method call accesses a property on this type
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
    params: Param[];
    structName?: string;
}

export interface Struct {
    name: string;
    location: SourceLocation;
    fields: Param[];
    methods: Function[];
}

export interface Param {
    name: string;
    type?: Type;
}

export interface Hole {
    location: SourceLocation;
    type: Type;
    context?: HoleContext;
    suggestions: Suggestion[]
}

export interface HoleContext {
    variables: Variable[];
    functions: Function[];
    fields: Param[];
    methods: Function[];
}

export interface ReturnType {
    type?: Type;
    location: SourceLocation;
}

export interface SourceLocation {
    line: number;
    column: number;
    length: number;
}

export const getSourceLocationKey = (loc: SourceLocation): string => {
    return `${loc.line}:${loc.column}:${loc.length}`;
};

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
    console.log(overrides)
    
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
        } else if (assignee.valType === ValType.STRUCT) {
            return assignee.structName === assigned.structName;
        }
        return true;
    }
    return false;
}

export default class MyInterpreter extends RustParserVisitor<ReturnType | null> {
    private typeStack: Type[] = [toType({valType: ValType.ROOT})];
    private variables: Variable[] = [];
    private functions: Function[] = [];
    private structs: Struct[] = [];
    private holes: Hole[] = [];
    
    private blockStack: string[] = ['global']; // Stack to track nested blocks
    private blockCounter: number = 0;          // Counter to generate unique block IDs

    private currentImplType: string | null = null;

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
        console.log("Looking for variable:", variableName, "Found:", variable)
        if(variable) {
            return variable;
        } else {
            throw Error("Variable not bound")
        }
    }

    getBoundFunction(functionName: string, structName: string | null = null): Function {
        const function_ = this.functions.find(function_ => (function_.name === functionName && (structName ? function_.structName === structName : true)))
        console.log(functionName)
        if(function_) {
            return function_;
        } else {
            throw Error("Function not bound")
        }
    }

    getBoundField(structName: string, identifier: string): Param {
        const struct = this.structs.find(s => s.name === structName);
        if (!struct) {
            throw Error(`Struct '${structName}' not found`);
        }
        const field = struct.fields.find(f => f.name === identifier);
        if (field) {
            return field;
        } else {
            throw Error(`Field '${identifier}' not found in struct '${structName}'`);
        }
    }

    getBoundMethod(structName: string, identifier: string): Function {
        const struct = this.structs.find(s => s.name === structName);
        if (!struct) {
            throw Error(`Struct '${structName}' not found`);
        }
        const method = struct.methods.find(m => m.name === identifier);
        if (method) {
            return method;
        } else {
            throw Error(`Method '${identifier}' not found in struct '${structName}'`);
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

        
    parseType = (typeString: string, genericArgs: string | null = null): Type => {
        console.log(typeString)
        if (!typeString) {
            return toType({valType: ValType.UNKNOWN});
        }

        if (typeString === 'integer') {
            return toType({valType: ValType.INT});
        }
        if (typeString === 'string') {
            return toType({valType: ValType.STRING});
        }
        console.log(typeString)

        if (typeString === 'Vec' && genericArgs) {
            const elementType = this.parseType(genericArgs); 
            return toType({valType: ValType.VECTOR, elementType: elementType.valType});
        }
        const refMatch = typeString.match(/^(&)?\s*(mut)?\s*([a-zA-Z_][a-zA-Z0-9_]*)$/);
        
        if (refMatch && refMatch[1] === '&') {
            const mutableReference = refMatch[2] === 'mut' ? true : false;
            const elementType = this.parseType(refMatch[3]);

            return toType({valType: ValType.REFERENCE, elementType: elementType.valType,mutableReference: mutableReference, mutable: null});
        }

        console.log(this.structs)
        console.log(typeString)

        // Check if it's a struct type
        if (this.structs.some(s => s.name === typeString)) {
            return toType({valType: ValType.STRUCT, structName: typeString});
        }

        if (typeString === 'Self') {
            return toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
        }

        return toType({valType: ValType.UNKNOWN});
    }

    visitCrate = (ctx: any): ReturnType => {
        console.log("Crate")
        const items = ctx.item();
        // Map over every item and visit it; filter out nulls if some items aren't implemented
        return items.map((item: ParseTree) => this.visit(item) as ReturnType).filter((n: ParseTree | null) => n !== null);
    };

    visitItem = (ctx: any): ReturnType | null => {
        console.log("Item")
        const visItem = ctx.visItem();
        if (visItem) {
            return this.visit(visItem) as ReturnType;
        }
        // Handle macroItem here if needed, otherwise return null
        return null; 
    };

    visitStructStruct = (ctx: any): ReturnType | null => {
        console.log("Struct")

        const structName = ctx.identifier().getText();
        const structFields = ctx.structFields()?.structField() || [];
        const fields: Param[] = structFields.map((field: any) => {
            const fieldName = field.identifier().getText();
            const fieldType = this.parseType(field.type_().getText());
            return {
                name: fieldName,
                type: fieldType
            };
        });


        const struct: Struct = {
            name: structName,
            location: getLocation(ctx),
            fields: fields,
            methods: []
        };

        console.log("Defined struct:", struct);

        this.structs.push(struct);

        return null;
    };

    visitInherentImpl = (ctx: any): ReturnType | null => {
        console.log("Inherent impl")
        const genericArgs = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).genericArgs().genericArgsTypes();
        const typeName = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier().getText();
        this.currentImplType = typeName;
        const associatedItems = ctx.associatedItem();
        associatedItems.forEach((item: any) => {
            this.visit(item);
        });
        console.log(this.currentImplType)
        console.log("functions: ", this.functions)
        this.currentImplType = null;
        return null;
    };

    visitAssignmentExpression = (ctx: any): ReturnType | null => {
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

    visitMacroInvocation = (ctx: any): ReturnType | null => {
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
                type: type,
                location: getLocation(ctx)
            }
        }

        return null;
    }

    visitLetStatement = (ctx: any): ReturnType | null => {
        console.log("Let statement")
        const variableName = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().identifier().getText();
        const mutable = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().KW_MUT() != null;

        // # TODO Hardcoded to work only for one
        const genericArgs = ctx.type_()?.typeNoBounds().traitObjectTypeOneBound()?.traitBound().typePath().typePathSegment(0).genericArgs()?.getText().slice(1, -1); 
        let declaredTypeString = ctx.type_()?.typeNoBounds().traitObjectTypeOneBound()?.traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier().getText();
        if (!declaredTypeString) {
            declaredTypeString = ctx.type_()?.getText();
        }
        
        console.log("Generic args:", genericArgs)
        const declaredType = this.parseType(declaredTypeString, genericArgs);
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

            const type = toType(valType);
            type.mutable = mutable;

            const variable: Variable = {name: variableName, type: type, location: getLocation(ctx)};

            this.variables.push(variable)
        }
        return null;
    }

    visitCallExpression = (ctx: any): ReturnType | null => {
        console.log("Call expression")
        let structName = null;
        let functionName = null;

        if (ctx.expression().pathExpression().pathInExpression().pathExprSegment().length > 1) {
            structName = ctx.expression().pathExpression().pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier().getText()
            functionName = ctx.expression().pathExpression().pathInExpression()?.pathExprSegment(1)?.pathIdentSegment().identifier().getText()
            
        } else {
            functionName = ctx.expression().pathExpression().pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier().getText()
        }
        console.log("Function call:", functionName, "Struct:", structName)
        const func = this.getBoundFunction(functionName, structName);

        ctx.callParams()?.expression().forEach((expr: any, i: number) => {
            const otherType = func.params[i].type;

            this.typeStack.push(otherType!)
            const type = this.visit(expr)?.type;
            if (expr instanceof PathExpression_Context) {
                this.consume(expr.getText())
            }
            this.typeStack.pop()
        })

        return { type: func.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
    }

    visitMethodCallExpression = (ctx: any): ReturnType | null => {
        console.log("MethodCallExpression");

        const receiver = ctx.expression();
        const methodSegment = ctx.pathExprSegment();
        const methodName = methodSegment?.pathIdentSegment()?.identifier()?.getText();

        this.visit(methodSegment?.pathIdentSegment()?.identifier())

        console.log("Method name:", methodName)

        // Mark the current expected type as having been used for a property-like method call
        const currentType = this.currentParentType;
        currentType.property = true;

        let receiverType = toType({valType: ValType.UNKNOWN});
        if (receiver) {
            receiverType = this.visit(receiver)?.type || receiverType;
        }

        const structName = receiverType?.structName ?? null;
        if (!methodName) {
            throw new Error("Unable to resolve method name for MethodCallExpression");
        }

        if (!structName) {
            throw new Error(`Cannot call method '${methodName}' on non-struct type`);
        }

        const func = this.getBoundMethod(structName, methodName);
        console.log("Method call:", func.name, "on struct", structName);


        ctx.callParams()?.expression().forEach((expr: any, i: number) => {
            const paramType = func.params[i + 1]?.type || toType({valType: ValType.UNKNOWN});
            console.log("Param type:", paramType)
            this.typeStack.push(paramType);
            this.visit(expr);
            if (expr instanceof PathExpression_Context) {
                this.consume(expr.getText());
            }
            this.typeStack.pop();
        });

        return { type: func.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
    }

    visitFieldExpression = (ctx: any): ReturnType | null => {
        console.log("FieldExpression");

        const receiver = ctx.expression();
        const fieldName = ctx.identifier()?.getText();

        const visitedField = this.visit(ctx.identifier())

        const variable = this.getBoundVariable(receiver.getText());

        if (visitedField?.type?.valType === ValType.HOLE) {
            const hole = {location: getLocation(ctx.identifier()), type: this.currentParentType, suggestions: []}
            this.generateStructHole(hole, variable.type.structName ?? 'unknown')
            return { type: visitedField.type, location: getLocation(ctx) };
        }

        if (!fieldName) {
            throw new Error("Unable to resolve field name for FieldExpression");
        }

        let receiverType = toType({valType: ValType.UNKNOWN});
        if (receiver) {
            receiverType = this.visit(receiver)?.type || receiverType;
        }

        const structName = receiverType?.structName ?? null;
        if (!structName) {
            throw new Error(`Cannot access field '${fieldName}' on non-struct type`);
        }

        const field = this.getBoundField(structName, fieldName);

        return { type: field.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
    }

    visitPathExpression = (ctx: any): ReturnType | null => {
        console.log("Path expression")
        if(ctx.parent.parent instanceof CallExpressionContext) { // Kinda useless now
            const func = this.getBoundFunction(ctx.getText());
            console.log("Function call:", func.name)
            return { type: func.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
        } else {
            const variable = this.getBoundVariable(ctx.getText());
            console.log("Variable:", variable.name)
            return { type: variable.type, location: getLocation(ctx) };
        }
    }

    visitFunction_ = (ctx: any): ReturnType => {
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
            // console.log("Parsing param:", paramName)
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

        const selfParam = ctx.functionParameters()?.selfParam();
        
        if (selfParam) {
            const type = toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
            if (selfParam.typedSelf()?.KW_MUT() || selfParam.shorthandSelf()?.KW_MUT()) {
                type.mutable = true;
            }
            this.variables.push({name: "self", type: type, location: getLocation(selfParam)});
            paramsParsed?.unshift({name: "self", type: type})
        }
        
        const functionRecord: Function = {
            name: name,
            location: getLocation(ctx),
            type: type,
            params: paramsParsed || []
        };

        if (this.currentImplType) {
            functionRecord.structName = this.currentImplType;
            const targetStruct = this.structs.find(s => s.name === this.currentImplType);
            if (targetStruct && selfParam) {
                targetStruct.methods.push(functionRecord);
            }
        }



        if (!selfParam) {
            this.functions.push(functionRecord);
        }

        const blockCtx = ctx.blockExpression();
        
        if (blockCtx) {
            this.visit(blockCtx);
        }
        
        this.typeStack.pop()
        
        this.variables = []; // Clear variables after function scope ends

        this.pushBlock(funcId);

        return {
            type: type,
            location: getLocation(ctx)
        };
    };

    visitBlockExpression = (ctx: any): ReturnType => {
        console.log("BlockExpression");

        const blockId = `block_${this.blockCounter++}`;
        this.pushBlock(blockId);
        
        const statementsNode = ctx.statements();
        
        const type = this.currentParentType

        const currentState = this.saveState()

        if (statementsNode) {
            this.visit(statementsNode);
        }

        this.loadState(currentState)

        this.popBlock();

        return {
            type: type,
            location: getLocation(ctx)
        };
    };
    
    visitStatements = (ctx: any): ReturnType => {
        console.log("Statements");
        
        const type = toType({valType: ValType.UNKNOWN});
        this.typeStack.push(type);

        // 1. Visit all individual 'statement' children
        const statements = ctx.statement()
        statements.forEach((statement: ParseTree) => {
            this.visit(statement)
        });
        
        // 2. Visit the optional trailing 'expression'
        const expr = ctx.expression();
        if (expr) {
            this.visit(expr);
        }

        this.typeStack.pop()
        return {
            type: type,
            location: getLocation(ctx)
        }
    };

    visitArithmeticOrLogicalExpression = (ctx: ArithmeticOrLogicalExpressionContext): ReturnType => {
        console.log("ArithmeticOrLogicalExpression")

        const leftChild = ctx.expression(0)
        const rightChild = ctx.expression(1)

        if (!leftChild || !rightChild) {
            throw new Error("Invalid binary expression: missing operands");
        }
        
        // 2. Recursively build the left and right AST branches
        const left = this.visit(leftChild) as ReturnType;
        const right = this.visit(rightChild) as ReturnType;

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
            type: type,
            location: getLocation(ctx)
        };
    };

    visitBorrowExpression = (ctx: BorrowExpressionContext): ReturnType => {
        console.log("BorrowExpression");
        const mutable = ctx.KW_MUT() != null;
        const exprCtx = ctx.expression();
        
        let owner = undefined;

        // If borrowing a variable, mark it as borrowed
        if (exprCtx instanceof PathExpression_Context) {
            const varName = exprCtx.getText();
            owner = this.borrow(varName, mutable);
        }
        
        const expr = this.visit(exprCtx) as ReturnType;
        
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
            type: type,
            location: getLocation(ctx)
        };
    };

    visitLiteralExpression = (ctx: any): ReturnType => {
        console.log("Literal Expression")

        if (ctx.INTEGER_LITERAL()) {
            return {
                type: toType({valType: ValType.INT}),
                location: getLocation(ctx)
            };
        }

        if (ctx.STRING_LITERAL() || ctx.RAW_STRING_LITERAL()) {
            return {
                type: toType({valType: ValType.STRING}),
                location: getLocation(ctx)
            };
        }

        // Fallback
        return {
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    };

    // TODO Remove or make work in general
    visitIdentifier = (ctx: any): ReturnType => {
        console.log("Identifier")
        const location = getLocation(ctx)
        const type = this.currentParentType;
        console.log("Alleged type:", type)
        
        if (ctx.getText() === "??") {
            const hole = {location: location, type: type, suggestions: []}
        }

        return {
            type: toType({valType: ValType.HOLE}),
            location: location
        };
    }

    visitHoleExpression = (ctx: any): ReturnType => {
        console.log("Hole expression")

        const location = getLocation(ctx)
        const type = this.currentParentType;
        console.log("Alleged type:", type)

        const hole = {location:location, type: type, suggestions: []}
        this.generateHole(hole)

        return {
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

        hole.suggestions = holeSuggestions;
        hole.context = {
            variables: structuredClone(this.variables),
            functions: structuredClone(this.functions),
            fields: [],
            methods: []
        };
        this.holes.push(hole);
    }
    
    public generateStructHole(hole: Hole, structName: string) {
        console.log("Generating struct hole for struct:", structName)
        const struct = this.structs.find(s => s.name === structName);
        if (!struct) return;
        let holeSuggestions = [] as Suggestion[];
        // console.log("Struct fields:", struct.fields)
        console.log("Hole type:", hole.type)
        struct.fields.forEach((field: Param) => {
            if (field.type && canBeAssigned(hole.type, field.type)) {
                holeSuggestions.push({suggestionType: 'field', suggestion: field});
            }
        });
        
        struct.methods.forEach((method: Function) => {
            if (method.type && canBeAssigned(hole.type, method.type)) {
                holeSuggestions.push({suggestionType: 'method', suggestion: method});
            }
        });
        
        hole.suggestions = holeSuggestions;
        hole.context = {
            variables: structuredClone(this.variables),
            functions: structuredClone(this.functions),
            fields: structuredClone(struct.fields),
            methods: structuredClone(struct.methods)
        };
        this.holes.push(hole);
    }

    static printHoleSuggestionContext(hole: Hole): void {
        const formatType = (type?: Type): string => {
            if (!type) {
                return 'unknown';
            }
            const base = type.valType === ValType.VECTOR
                ? `Vec<${type.elementType ?? 'unknown'}>`
                : type.valType === ValType.REFERENCE
                    ? `&${type.mutableReference ? 'mut ' : ''}${type.elementType ?? 'unknown'}`
                    : type.valType;
            const mut = type.mutable === true ? 'mut ' : '';
            return `${mut}${base}`;
        };

        const formatLocation = (loc: SourceLocation): string =>
            `line ${loc.line}, col ${loc.column}, len ${loc.length}`;

        const printSection = (title: string, lines: string[]) => {
            console.log(`${title}:`);
            if (lines.length === 0) {
                console.log('  (none)');
                return;
            }
            lines.forEach(line => console.log(`  ${line}`));
        };

        const formatTypeMetadata = (type?: Type): string => {
            if (!type) {
                return 'unknown';
            }
            const ownerName = type.owner ? type.owner.name : 'none';
            const borrowName = type.borrows === Borrow.BFree ? 'free' : type.borrows === Borrow.BMut ? 'mut' : 'immut';
            return `{
    valType: ${type.valType},
    elementType: ${type.elementType ?? 'none'},
    primitive: ${type.primitive},
    mutable: ${type.mutable},
    mutableReference: ${type.mutableReference},
    consumed: ${type.consumed},
    borrows: ${borrowName},
    owner: ${ownerName}
}`;
        };

        console.log('--- Hole suggestion context ---');
        console.log(`Hole location: ${formatLocation(hole.location)}`);
        console.log(`Hole type: ${formatType(hole.type)}`);
        console.log(`Hole type metadata: ${formatTypeMetadata(hole.type)}`);

        const suggestionLines = hole.suggestions.map(suggestion => {
            if (suggestion.suggestionType === 'variable') {
                const variable = suggestion.suggestion as Variable;
                return `variable: ${variable.name} : ${formatType(variable.type)} ${formatTypeMetadata(variable.type)} (${formatLocation(variable.location)})`;
            }
            if (suggestion.suggestionType === 'function') {
                const func = suggestion.suggestion as Function;
                const params = func.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
                return `function: ${func.name}(${params}) -> ${formatType(func.type)} (${formatLocation(func.location)})`;
            }
            return `${suggestion.suggestionType}: ${JSON.stringify(suggestion.suggestion)}`;
        });

        const variableLines = hole.context?.variables.map(variable =>
            `${variable.name}: ${formatType(variable.type)} ${formatTypeMetadata(variable.type)} (${formatLocation(variable.location)})`
        ) ?? [];

        const functionLines = hole.context?.functions.map(func => {
            const params = func.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
            return `${func.name}(${params}) -> ${formatType(func.type)} (${formatLocation(func.location)})`;
        }) ?? [];

        printSection('Suggestions', suggestionLines);
        printSection('Context variables', variableLines);
        printSection('Context functions', functionLines);
        console.log('--- End hole suggestion context ---\n\n');
    }

    public getFinalResult() {
        const holes = this.holes;

        let holeSuggestions = new Map<string, Hole>();
        
        holes.forEach((hole: Hole) => {
            const key = getSourceLocationKey(hole.location);
            holeSuggestions.set(key, hole)
        });
        console.log("Suggestions:");
        console.log(holeSuggestions)
        return holeSuggestions;
    }
}