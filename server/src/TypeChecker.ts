import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, CallExpressionContext, PathExpression_Context, PathExpressionContext, BorrowExpressionContext, IdentifierContext, GroupedExpressionContext, ArrayExpressionContext, IndexExpressionContext, TypeCastExpressionContext, HoleExpressionContext, SlicePatternContext, FieldExpressionContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree } from 'antlr4ng';
import { UsageGraphListener } from './UsageListener';
import { ValType, Borrow, Type, SourceLocation, Variable, Struct, Hole, Function, ReturnType, Param, Suggestion } from '../../shared/out/types.js';
import { toType, getSourceLocationKey, getLocation } from './utils';
import { parseStdJsonFile } from './stdParser';


export default class TypeChecker extends RustParserVisitor<ReturnType | null> {
    private typeStack: Type[] = [toType({valType: ValType.ROOT})];
    private variables: Variable[] = [];
    private functions: Function[] = [];
    private structs: Struct[] = [];
    private stdFunctions: Function[] = [];
    private stdStructs: Struct[] = [];
    private holes: Hole[] = [];
    
    private blockStack: string[] = ['global']; // Stack to track nested blocks
    private blockCounter: number = 0;          // Counter to generate unique block IDs

    private currentImplType: string | null = null;

    private usageListener: UsageGraphListener;

    constructor(usageListener: UsageGraphListener) {
        super();
        this.usageListener = usageListener;

        this.loadStdLibrary();
    }

    private loadStdLibrary() {
        const { functions, structs } = parseStdJsonFile();
        this.stdFunctions = functions;
        this.stdStructs = structs;
        console.log(this.stdFunctions);
        console.log(this.stdStructs);
        console.log("Finished loading std library")
    }

    // ============================================= UTIL METHODS =============================================

    findStructFromUserImport(userImportPathString: string): Struct | undefined {
        // 1. Split the user's string: "std::collections::HashSet" -> ["std", "collections", "HashSet"]
        const userSegments = userImportPathString.split('::');
        const importedTypeName = userSegments[userSegments.length - 1]; // "HashSet"

        for (const structObj of this.stdStructs) {
            // 2. Filter instantly by the base type name
            const registryTypeName = structObj.path[structObj.path.length - 1];
            if (registryTypeName !== importedTypeName) continue;

            // 3. Perform a Suffix Match / Permissive check
            // User paths look like: 'std::collections::HashSet'
            // Index paths look like: 'hashbrown::set::HashSet' or 'alloc::collections::hash::set::HashSet'
            
            // Check if the structures line up logically at the end or share common modules
            if (this.isPathMatch(userSegments, structObj.path)) {
                return structObj; // Found the matching internal metadata entry!
            }
        }
        return undefined;
    }

    isPathMatch(userPath: string[], registryPath: string[]): boolean {
        // A secure base validation rule: if item name matches, check context
        const userTypeName = userPath[userPath.length - 1];
        const registryTypeName = registryPath[registryPath.length - 1];
        
        if (userTypeName !== registryTypeName) return false;

        // Standard collections mapping helper for facade items
        // Since std facades things like collections, we ensure common structural groups match
        if (userPath.includes("collections") && (registryPath.includes("collections") || registryPath.includes("hashbrown"))) {
            return true;
        }

        // Default strict fallback: check if trailing module scopes overlap
        // e.g. "ffi::c_str::CString" matches "std::ffi::CString" via 'ffi'
        const commonModule = userPath[userPath.length - 2];
        return registryPath.includes(commonModule);
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

    borrow(variableName: string, mutable: boolean, location: SourceLocation): Variable {
        const variable = this.getBoundVariable(variableName);

        if (variable.type?.borrows === Borrow.BFree) {
            variable.type.borrows = mutable ? Borrow.BMut : Borrow.BImmut
        } else if (variable.type?.borrows === Borrow.BMut && !this.checkBorrows(variable.type.owner!, location)) {
            throw Error("Cannot borrow, already mutably borrowed")
        } else {
            if (mutable && !this.checkBorrows(variable.type.owner!, location)) {
                throw Error("Cannot mutably borrow, already immutably borrowed")
            }
        }
        variable.type.mutableReference = mutable;
        return variable;
    }

    consume(variableName: string) {
        const variable = this.getBoundVariable(variableName)
        if (variable.type.primitive || variable.type.valType === ValType.REFERENCE) {
            return
        }
        if (variable.type.consumed) {
            throw Error("Cannot consume already consumed variable")
        }
        variable.type.consumed = true
    }

    private get currentParentType(): Type {
        return this.typeStack[this.typeStack.length - 1];
    }

    parseType(type: any): Type {
        // TODO Hardcoded for only one generic arg
        const genericArgs = type?.typeNoBounds?.().traitObjectTypeOneBound()?.traitBound().typePath().typePathSegment(0).genericArgs()?.getText().slice(1, -1); 
        let typeString = type?.typeNoBounds?.().traitObjectTypeOneBound()?.traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier()?.getText();
        
        if (!typeString) {
            typeString = type?.getText(); // pretty ugly does not use typing well
        }

        return this.parseStringType(typeString, genericArgs);
    }    

    parseStringType = (typeString: string, genericArgs?: string): Type => {
        if (!typeString) {
            return toType({valType: ValType.UNKNOWN});
        }

        if (typeString === 'integer') {
            return toType({valType: ValType.INT});
        }
        if (typeString === 'str') {
            return toType({valType: ValType.STRING});
        }

        if (typeString === 'Vec' && genericArgs) {
            const elementType = this.parseStringType(genericArgs); 
            if (this.structs.find(s => s.name === "Vec")) {
                return toType({valType: ValType.STRUCT, structName: "Vec", elementType: elementType.valType});
            } else {
                return toType({valType: ValType.VECTOR, elementType: elementType.valType});
            }
        }
        const refMatch = typeString.match(/^(&)?\s*(mut)?\s*([a-zA-Z_][a-zA-Z0-9_]*)$/);
        
        if (refMatch && refMatch[1] === '&') {
            const mutableReference = refMatch[2] === 'mut' ? true : false;
            const elementType = this.parseStringType(refMatch[3]);

            return toType({valType: ValType.REFERENCE, elementType: elementType.valType, mutableReference: mutableReference, structName: elementType.structName});
        }

        // Check if it's a struct type
        if (this.structs.some(s => s.name === typeString)) {
            return toType({valType: ValType.STRUCT, structName: typeString});
        }

        if (typeString === 'Self') {
            return toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
        }

        return toType({valType: ValType.UNKNOWN});
    }

    checkBorrows(owner: Variable, location: SourceLocation, variableName: string | null = null): boolean {
        console.log("hey")
        console.log(owner)
        console.log(variableName)
        if (owner) {
            const borrows = this.variables.filter(v => v.type.owner === owner && v !== owner)

            if (!borrows.every(v => v.name === variableName || this.usageListener.isVariableFree(v.name, this.getCurrentBlock(), location.line))) {
                return false;
            }
        }
        return true;
    }

    canBeAssigned(assignee: Hole | Param, assigned: Type, owner: Variable | null = null, checkMutability: boolean = true): boolean {
        
        // console.log("Checking assignability. Assignee type:", assignee.type, "Assigned type:", assigned)
        if (checkMutability && assignee.type.mutable && !assigned.mutable) {
            return false;
        }

        if (assigned.primitive && assignee.type.valType === assigned.valType) {
            return true;
        }

        if (assigned.borrows === Borrow.BMut) {
            if (!this.checkBorrows(owner!, owner!.location)) {
                return false;
            }
        } else if (assigned.borrows === Borrow.BImmut && ((assignee.type.valType === ValType.REFERENCE && assignee.type.mutableReference) || assignee.type.valType !== ValType.REFERENCE)  ) {
            if (!this.checkBorrows(owner!, owner!.location)) {
                return false;
            }
        }
        
        if (assignee.type.valType === ValType.UNKNOWN) {
            return true;
        }

        if (assignee.type.valType === assigned.valType) {
            if (assignee.type.valType === ValType.VECTOR ) {
                return assignee.type.elementType === assigned.elementType;
            } else if (assignee.type.valType === ValType.REFERENCE) {
                if (assignee.type.mutableReference && !assigned.mutableReference) {
                    return false;
                }
                return assignee.type.elementType === assigned.elementType;
            } else if (assignee.type.valType === ValType.STRUCT) {
                return assignee.type.structName === assigned.structName;
            }
            return true;
        }

        return false;
    }

    // ============================================= VISIT METHODS =============================================

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

    visitStructStruct = (ctx: any): ReturnType | null => {
        console.log("Struct")

        const structName = ctx.identifier().getText();
        const structFields = ctx.structFields()?.structField() || [];
        const fields: Param[] = structFields.map((field: any) => {
            const fieldName = field.identifier().getText();
            const fieldType = this.parseType(field.type_());
            return {
                name: fieldName,
                type: fieldType,
                location: getLocation(field)
            };
        });


        const struct: Struct = {
            name: structName,
            path: [structName],
            location: getLocation(ctx),
            fields: fields,
            methods: []
        };

        this.structs.push(struct);

        return null;
    };

    visitInherentImpl = (ctx: any): ReturnType | null => {
        console.log("Inherent impl")

        const genericArgs = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).genericArgs()?.genericArgsTypes();
        const typeName = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier().getText();
        
        this.currentImplType = typeName;

        const associatedItems = ctx.associatedItem();
        associatedItems.forEach((item: any) => {
            this.visit(item);
        });

        this.currentImplType = null;
        return null;
    };

    visitTraitImpl = (ctx: any): ReturnType | null => {
        console.log("Trait impl")
        
        const genericArgs = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).genericArgs()?.genericArgsTypes();
        const typeName = ctx.type_().typeNoBounds().traitObjectTypeOneBound().traitBound().typePath().typePathSegment(0).pathIdentSegment().identifier().getText();

        const struct = this.structs.find(s => s.name === typeName);

        if (ctx.typePath().getText() === "Iterator") {
            if (struct) {
                struct.iterable = true;
            } else {
                throw Error(`Struct '${typeName}' not found for Iterator impl`);
            }
        }

        if (ctx.typePath().getText() === "Index") {
            if (struct) {
                struct.index = true;
            } else {
                throw Error(`Struct '${typeName}' not found for Index impl`);
            }
        }

        return null;
    };

    visitAssignmentExpression = (ctx: any): ReturnType | null => {
        console.log("Assignment expression")

        const leftHandExpression = ctx.expression(0);

        let variable;
        let varType;

        if (leftHandExpression instanceof FieldExpressionContext) {
            variable = this.getBoundVariable(leftHandExpression.expression().getText());
            varType = this.getBoundField(variable.type.structName!, leftHandExpression.identifier().getText()).type
        } else {
            const variableName = leftHandExpression.getText();
            variable = this.getBoundVariable(variableName)
            varType = variable.type
        }
        const expression = ctx.expression(1);


        if (!variable.type.mutable && !variable.type.mutableReference) {
            throw Error("Cannot modify immutable variable", ctx.expression(0).getText())
        }

        if (varType) {
            this.typeStack.push(varType);
        }

        let inferedType: Type = toType({valType: ValType.UNKNOWN});
        if (expression) {
            inferedType = this.visit(expression)?.type as Type;
        }

        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }

        variable.location = getLocation(ctx);

        this.typeStack.pop();

        return null
    }
    
    visitLetStatement = (ctx: any): ReturnType | null => {
        console.log("Let statement")
        const variableName = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().identifier().getText();
        const mutable = ctx.patternNoTopAlt().patternWithoutRange().identifierPattern().KW_MUT() != null;
        
        console.log("Variable name:", variableName)

        const declaredType = this.parseType(ctx.type_());
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
        
        // console.log("Inferred type: ", inferedType, "Declared type: ", declaredType)
        if (recordVar) {
            let valType = inferedType;
            if ( inferedType.valType === ValType.UNKNOWN || (inferedType.elementType === ValType.UNKNOWN && declaredType.elementType && declaredType.elementType !== ValType.UNKNOWN) ) {
                valType = declaredType;
            }
            
            const type = toType(valType);
            type.mutable = mutable;
            
            const variable: Variable = {name: variableName, type: type, location: getLocation(ctx)};
            
            this.variables.push(variable)
        }
        return null;
    }

    // Parse an array like vec![1, 2, 3] and infer its type as Vec<integer>
    visitMacroInvocation = (ctx: any): ReturnType | null => {
        console.log("Macro invocation")
        if (ctx.simplePath().getText() === "vec") {
            let type : Type = toType({valType: ValType.VECTOR, elementType: ValType.UNKNOWN});
            const tokens = ctx.delimTokenTree().tokenTree(0)?.tokenTreeToken();
            // if (!tokens) {
            //     return {
            //         type: toType({valType: ValType.VECTOR, elementType: ValType.UNKNOWN}),
            //         location: getLocation(ctx)
            //     }
            // }
            if (tokens) {
                if (tokens.every((val:any, i:number) => (i % 2 === 1 ? val.getText() === ',' : true))) { // List vec macro like vec![1, 2, 3]
                    tokens.forEach((token: any, i: number) => {
                        if (i % 2 === 0) {
                            const elType = this.visit(token)!.type!.valType;
                            if (type.elementType === ValType.UNKNOWN) {
                                type = toType({valType: ValType.VECTOR, elementType: elType});
                            } else if (type.elementType !== elType) {
                                throw Error("All elements in vec must be of same type")
                            }
                        }
                    })
                } else if (tokens.length === 3 && tokens[1].getText() === ";") { // Repeat vec macro like vec![0; 10]
                    const elType = this.visit(tokens[0])!.type!.valType;
                    const countType = this.visit(tokens[2])!.type!.valType;

                    if (countType === ValType.INT) {
                        type = toType({valType: ValType.VECTOR, elementType: elType});
                    } else if (type.elementType !== elType) {
                        throw Error("Element type mismatch in vec! macro")
                    }
                } else {
                    throw Error("Only simple vec macros with commas are supported")
                }
            }

            if (this.structs.find(s => s.name === "Vec")) {
                type.structName = "Vec";
                type.valType = ValType.STRUCT;
            }

            return {
                type: type,
                location: getLocation(ctx)
            }
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

        console.log(this.functions)
        console.log(this.structs)

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
        console.log("Method name:", methodName)

        this.visit(methodSegment?.pathIdentSegment()?.identifier())

        let receiverType = toType({valType: ValType.UNKNOWN});
        if (receiver) {
            receiverType = this.visit(receiver)?.type || receiverType;
        }

        const structName = receiverType?.structName;
        if (!methodName) {
            throw new Error("Unable to resolve method name for MethodCallExpression");
        }

        if (!structName) {
            throw new Error(`Cannot call method '${methodName}' on non-struct type '${receiverType.valType}'`);
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

    visitStructExprStruct = (ctx: any): ReturnType | null => {
        console.log("Struct expression")
        
        let structName = null;
        
        if (ctx.pathInExpression().pathExprSegment(0).pathIdentSegment().identifier()) {
            structName = ctx.pathInExpression().pathExprSegment(0).pathIdentSegment().identifier().getText();
        } else if (ctx.pathInExpression().pathExprSegment(0).pathIdentSegment().KW_SELFTYPE()) {
            structName = this.currentImplType;
        }

        const struct = this.structs.find(s => s.name === structName);
        if (!struct) {
            throw new Error(`Struct '${structName}' not found for struct expression`);
        }

        // TODO: Needs to also check fields

        return {
            type: toType({valType: ValType.STRUCT, structName: structName}),
            location: getLocation(ctx)
        }
    }

    visitIteratorLoopExpression = (ctx: any): ReturnType | null => {
        console.log("IteratorLoopExpression");

        let pattern = ctx.pattern().patternNoTopAlt(0).patternWithoutRange().identifierPattern?.();
        if (!pattern) {
            pattern = ctx.pattern().patternNoTopAlt(0).patternWithoutRange().referencePattern()?.patternWithoutRange().identifierPattern();
        }
        if (!pattern && !ctx.pattern().patternNoTopAlt(0).patternWithoutRange().wildcardPattern()) {
            throw new Error("Only simple identifier patterns or wildcard patterns are supported in for loops")
        }

        const currentState = this.saveState();

        if (pattern) {
            const variableName = pattern.identifier().getText();
            const mutable = pattern.KW_MUT() != null;

            const iteratorType = this.visit(ctx.expression())?.type || toType({valType: ValType.UNKNOWN});
            let elementType = toType({valType: ValType.UNKNOWN});

            if (iteratorType.valType === ValType.VECTOR || (iteratorType.valType === ValType.RANGE)) {
                elementType = toType({valType: iteratorType.elementType ?? ValType.UNKNOWN});
            } else if (iteratorType.valType === ValType.REFERENCE && iteratorType.elementType === ValType.VECTOR) {
                elementType = toType({valType: iteratorType.elementType ?? ValType.UNKNOWN});
            }


            const loopVariable: Variable = {
                name: variableName,
                type: elementType,
                location: getLocation(pattern)
            };
            loopVariable.type.mutable = mutable;
            this.variables.push(loopVariable);
        }

        this.visit(ctx.blockExpression());

        this.loadState(currentState);

        return {
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    }

    visitFieldExpression = (ctx: any): ReturnType | null => {
        console.log("FieldExpression");

        const receiver = ctx.expression();
        const fieldName = ctx.identifier()?.getText();

        const visitedField = this.visit(ctx.identifier())

        const variable = this.getBoundVariable(receiver.getText());

        if (visitedField?.type?.valType === ValType.HOLE) {
            const hole = {location: getLocation(ctx.identifier()), type: this.currentParentType, suggestions: []}
            this.generateStructHole(hole, variable)
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

    visitIfExpression = (ctx: any): ReturnType => {
        console.log("If expression")

        const currentState = this.saveState();

        this.visit(ctx.blockExpression(0));

        this.loadState(currentState);

        if (ctx.KW_ELSE()) {
            this.visit(ctx.blockExpression(1));
        }

        return {
            type: this.currentParentType,
            location: getLocation(ctx)
        }
    }


    visitFunction_ = (ctx: any): ReturnType => {
        console.log("Function");

        const funcName = ctx.identifier()?.getText() ?? 'unknown';
        const funcId = `func_${funcName}`;
        this.pushBlock(funcId);

        let type = toType({valType: ValType.VOID})
        if(ctx.functionReturnType()) {
            type = this.parseType(ctx.functionReturnType().type_());
        }

        this.typeStack.push(type);
        
        // 1. Get the function name
        // The identifier rule is a child of the function rule
        const name = ctx.identifier().getText();
        
        const params = ctx.functionParameters()?.functionParam();
        
        const paramsParsed = params?.map((param: any) => {
            
            const pattern = param.functionParamPattern().pattern().patternNoTopAlt(0).patternWithoutRange().identifierPattern();
            const paramName = pattern.identifier().getText();
           
            const mutable = pattern.KW_MUT() != null;
            const type = this.parseType(param.functionParamPattern().type_());
            type.mutable = mutable;
            const variable: Variable = {name: paramName, type: type, location: getLocation(param)};
            
            this.variables.push(variable)
            
            return {
                name: paramName, 
                type: type,
                location: getLocation(param)
            }
        })

        const selfParam = ctx.functionParameters()?.selfParam();
        
        if (selfParam) {
            const type = toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
            if (selfParam.shorthandSelf().KW_MUT()) {
                if(selfParam.shorthandSelf().AND()) {
                    type.valType = ValType.REFERENCE;
                    type.elementType = ValType.STRUCT;
                    type.mutableReference = true;
                } else {
                    type.mutable = true;
                }
            } else {
                if(selfParam.shorthandSelf().AND()) {
                    type.valType = ValType.REFERENCE;
                    type.elementType = ValType.STRUCT;
                    type.mutableReference = false;
                }
            }
            this.variables.push({name: "self", type: type, location: getLocation(selfParam)});
            paramsParsed?.unshift({name: "self", type: type, location: getLocation(selfParam)});
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
        
        const type = this.currentParentType;
        

        const statements = ctx.statement()
        statements.forEach((statement: ParseTree) => {
            this.visit(statement)
        });
        
        // 2. Visit the optional trailing 'expression'
        const expr = ctx.expression();
        if (expr) {
            this.visit(expr);
        }

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

        let left = null;
        let right = null;

        if (leftChild.getText() === '??') {
            right = this.visit(rightChild) as ReturnType;
            this.typeStack.push(right.type || toType({valType: ValType.UNKNOWN}));
            left = this.visit(leftChild) as ReturnType;
        } else {
            left = this.visit(leftChild) as ReturnType;
            this.typeStack.push(left.type || toType({valType: ValType.UNKNOWN}));
            right = this.visit(rightChild) as ReturnType;
        }

        this.typeStack.pop();
        

        let type: Type;

        if (left.type?.valType === ValType.HOLE || right.type?.valType === ValType.HOLE) {
            type = toType({valType: ValType.HOLE});
        } else if (left.type?.valType === right.type?.valType) {
            type = left.type!;
        } else {
            type = toType({valType: ValType.UNKNOWN});
        }

        return {
            type: type,
            location: getLocation(ctx)
        };
    };

    visitGroupedExpression = (ctx: GroupedExpressionContext): ReturnType => {
        console.log("Grouped Expression")

        const expr = this.visit(ctx.expression());

        return {
            type: expr?.type || toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    };

    visitIndexExpression = (ctx: any): ReturnType => {
        console.log("Index Expression")

        const array = this.visit(ctx.expression(0)!);

        this.typeStack.push(toType({valType: ValType.INT}));

        const index = this.visit(ctx.expression(1)!);

        this.typeStack.pop();

        const type = toType({valType: array!.type?.elementType || ValType.UNKNOWN});

        // If it is a variable borrow it
        if (ctx.expression(0) instanceof PathExpression_Context) {
            this.borrow(ctx.expression(0)!.getText(), true, getLocation(ctx)) // TODO Unhardcode the mutable borrow
        }


        return {
            type: type,
            location: getLocation(ctx)
        };
    };

    visitTypeCastExpression = (ctx: TypeCastExpressionContext): ReturnType => {
        console.log("Type Cast Expression")

        const type = this.parseType(ctx.typeNoBounds());

        return {
            type: type,
            location: getLocation(ctx)
        };
    }

    visitBorrowExpression = (ctx: BorrowExpressionContext): ReturnType => {
        console.log("BorrowExpression");
        const mutable = ctx.KW_MUT() != null;
        const exprCtx = ctx.expression();
        
        let owner = undefined;

        // If borrowing a variable, mark it as borrowed
        if (exprCtx instanceof PathExpression_Context) {
            const varName = exprCtx.getText();
            owner = this.borrow(varName, mutable, getLocation(ctx));
        }
        
        const expr = this.visit(exprCtx) as ReturnType;
        
        const type = new Type();
        type.valType = ValType.REFERENCE;
        type.elementType = expr.type!.valType;
        type.primitive = false;
        type.consumed = false;
        type.borrows = Borrow.BFree;
        type.mutableReference = mutable;
        type.owner = owner;
        type.structName = expr.type!.structName;

        return {
            type: type,
            location: getLocation(ctx)
        };
    };

    visitRangeExpression = (ctx: any): ReturnType => {
        console.log("Range Expression")

        const type = toType({valType: ValType.UNKNOWN});
        const start = this.visit(ctx.expression(0));
        const end = ctx.expression(1) ? this.visit(ctx.expression(1)) : null;

        if (start?.type?.valType === ValType.INT && (!end || end.type?.valType === ValType.INT)) {
            type.valType = ValType.RANGE;
            type.elementType = ValType.INT;
        }

        return {
            type: type,
            location: getLocation(ctx)
        };
    };


    // ================================================= GENERATING HOLE SUGGESTIONS =================================================

    // TODO Remove or make work in general
    visitIdentifier = (ctx: any): ReturnType => {
        console.log("Identifier")
        
        if (ctx.getText() === "??") {
            const location = getLocation(ctx)
            const type = this.currentParentType;
            console.log("Alleged type:", type)
            const hole = {location: location, type: type, suggestions: []}
            return {
                type: toType({valType: ValType.HOLE}),
                location: location
            };
        }
        return {
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    }

    visitHoleExpression = (ctx: any): ReturnType => {
        console.log("Hole expression")

        const location = getLocation(ctx)
        const type = this.currentParentType;
        console.log("Alleged type:", type)
        console.log("Location:", location)
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
            // console.log("Checking variable:", variable.name, "of type", variable.type)
            if (variable.type && this.canBeAssigned(hole, variable.type, variable, false) && !variable.type.consumed) {
                if (this.checkBorrows(variable.type.owner!, hole.location, variable.name)) {
                    holeSuggestions.push({suggestionType: 'variable', suggestion: variable});
                }
            }
            if (hole.type.valType === ValType.REFERENCE && variable.type.valType === hole.type.elementType && !variable.type.consumed && (variable.type.valType === ValType.STRUCT ? variable.type.structName === hole.type.structName : true)) {
                if (hole.type.mutableReference) {
                    if (variable.type.mutable) {
                        if (variable.type.borrows === Borrow.BFree) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&mut " + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                        } else {
                            if (this.checkBorrows(variable, hole.location, variable.name)) {
                                holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&mut " + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                            }
                        }
                    }
                } else {
                    if (variable.type.borrows === Borrow.BFree || variable.type.borrows === Borrow.BImmut) {
                        holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&" + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, structName: variable.type.structName}), location: variable.location}});
                    } else {
                        if (this.checkBorrows(variable, hole.location, variable.name)) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: "&" + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type.valType, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                        }
                    }
                }
            }
            if (variable.type.valType === ValType.STRUCT || ( variable.type.valType === ValType.REFERENCE && variable.type.elementType === ValType.STRUCT)) {
                const struct = this.structs.find(s => s.name === variable.type.structName);
                if (struct) {
                    // console.log("Checking struct:", struct.name)
                    struct.fields.forEach((field: Param) => {
                        if (field.type && this.canBeAssigned(hole, field.type)) {
                            holeSuggestions.push({suggestionType: 'field', suggestion: {...field, name: variable.name + "." + field.name, location: variable.location}});
                        }
                    });
                    struct.methods.forEach((method: Function) => {
                        if (method.type && this.canBeAssigned(hole, method.type, null, false)) {
                            holeSuggestions.push({suggestionType: 'method', suggestion: {...method, name: variable.name + "." + method.name + "()", location: variable.location}});
                        }
                    });
                    const refType = new Type();
                    Object.assign(refType, variable.type);
                    refType.valType = ValType.REFERENCE;
                    refType.elementType = variable.type.valType;
                    refType.mutableReference = variable.type.mutable;
                    if (struct.index && (this.canBeAssigned(hole, variable.type) || this.canBeAssigned(hole, refType))) {
                        holeSuggestions.push({suggestionType: 'slice', suggestion: {...struct, name: "&" + variable.name + "[??..??]", location: variable.location}});
                    }

                }
            }
        });
        
        functions.forEach((func: Function) => {
            // console.log("Checking function:", func.name, "of type", func.type)
            if (func.type && this.canBeAssigned(hole, func.type, null, false)) {
                holeSuggestions.push({suggestionType: 'function', suggestion: {...func, name: func.name + "()", location: func.location}});
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
    
    public generateStructHole(hole: Hole, variable: Variable) {
        const structName = variable.type.structName;
        console.log("Generating struct hole for struct:", structName)
        const struct = this.structs.find(s => s.name === structName);
        if (!struct) return;
        let holeSuggestions = [] as Suggestion[];

        struct.fields.forEach((field: Param) => {
            if (field.type && this.canBeAssigned(hole, field.type)) {
                holeSuggestions.push({suggestionType: 'field', suggestion: field});
            }
        });
        
        struct.methods.forEach((method: Function) => {
            // console.log("Checking method:", method.name)
            const methodRefType = new Type();
            Object.assign(methodRefType, variable.type);
            methodRefType.valType = ValType.REFERENCE;
            methodRefType.elementType = variable.type.valType;
            methodRefType.mutableReference = variable.type.mutable;
            if (method.type && this.canBeAssigned(hole, method.type, null, false) && (this.canBeAssigned(method.params[0], variable.type, variable) || this.canBeAssigned(method.params[0], methodRefType, variable))) {
                holeSuggestions.push({suggestionType: 'method', suggestion: {...method, name: method.name + "()"}});
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