import { RustParserVisitor } from './parser/RustParserVisitor';
import { ArithmeticOrLogicalExpressionContext, CallExpressionContext, PathExpression_Context, PathExpressionContext, BorrowExpressionContext, IdentifierContext, GroupedExpressionContext, ArrayExpressionContext, IndexExpressionContext, TypeCastExpressionContext, HoleExpressionContext, SlicePatternContext, FieldExpressionContext, CompoundAssignmentExpressionContext, DereferenceExpressionContext, TupleExpressionContext } from './parser/RustParser';
import { ParserRuleContext, ParseTree } from 'antlr4ng';
import { UsageGraphListener } from './UsageListener';
import { ValType, Borrow, Type, SourceLocation, Variable, Struct, Hole, Function, ReturnType, Param, Suggestion, SharedStruct, Trait, getAllMethods, FunctionOrigin, INTEGER_TYPE_NAMES, FLOAT_TYPE_NAMES, structNamesCompatible } from '../../shared/out/types.js';
import { toType, primitiveType, getSourceLocationKey, getLocation, cloneType, cloneVariable, cloneFunction, cloneParam } from './utils';
import { parseStdJsonFile, StdParseResult } from './stdParser';


function typesEqual(a: Type | undefined, b: Type | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return true;
    if (a.valType === ValType.UNKNOWN || b.valType === ValType.UNKNOWN) return true;
    if (a.valType !== b.valType) return false;
    if (a.valType === ValType.TUPLE) {
        const aMembers = a.elementTypes ?? [];
        const bMembers = b.elementTypes ?? [];
        return aMembers.length === bMembers.length
            && aMembers.every((member, i) => typesEqual(member, bMembers[i]));
    }
    if (!structNamesCompatible(a.structName, b.structName)) return false;
    return typesEqual(a.elementType, b.elementType);
}

// Split text on separator, ignoring separators nested inside brackets
function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of text) {
        if (ch === '(' || ch === '[' || ch === '<') depth++;
        else if (ch === ')' || ch === ']' || ch === '>') depth--;

        if (ch === separator && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);

    return parts.filter(p => p.trim().length > 0);
}

// Split a list of tokens on separator
function splitOn(tokens: any[], separator: string): any[][] {
    const groups: any[][] = [[]];
    for (const token of tokens) {
        if (token.getText() === separator) {
            groups.push([]);
        } else {
            groups[groups.length - 1].push(token);
        }
    }
    return groups.filter(g => g.length > 0);
}

function isIntegerType(type: Type | undefined): boolean {
    return type?.valType === ValType.STRUCT && INTEGER_TYPE_NAMES.includes(type.structName ?? '');
}

// Substitute self with the correct struct name
function substituteType(type: Type | undefined, structName: string, bindings: Record<string, Type>, selfArgument?: Type): Type | undefined {
    if (!type) return type;

    const bound = type.genericName ? bindings[type.genericName] : undefined;
    if (bound) return cloneType(bound);

    if (type.structName !== 'Self' && !type.elementType) return type;

    const resolved = cloneType(type);
    if (resolved.structName === 'Self') {
        resolved.structName = structName;
        if (!resolved.elementType && selfArgument) {
            resolved.elementType = cloneType(selfArgument);
        }
    }
    resolved.elementType = substituteType(resolved.elementType, structName, bindings, selfArgument);
    
    if (resolved.valType === ValType.REFERENCE && resolved.elementType) {
        resolved.structName = resolved.elementType.structName;
    }
    return resolved;
}

// A copy of the function with Self replaced by correct struct name
function substituteInFunction(func: Function, structName: string, bindings: Record<string, Type> = {}, selfArgument?: Type): Function {
    if (structName === 'Self' && Object.keys(bindings).length === 0) return func;

    return {
        ...func,
        type: substituteType(func.type, structName, bindings, selfArgument),
        params: func.params.map(p => ({ ...p, type: substituteType(p.type, structName, bindings, selfArgument)! })),
    };
}

// Primitive groups for as casts
type PrimGroup = 'integer' | 'float' | 'bool' | 'char';

function primGroupOf(name?: string): PrimGroup | undefined {
    if (!name) return undefined;
    if (INTEGER_TYPE_NAMES.includes(name)) return 'integer';
    if (FLOAT_TYPE_NAMES.includes(name)) return 'float';
    if (name === 'bool') return 'bool';
    if (name === 'char') return 'char';
    return undefined;
}

// Representative for primitive type groups
const GROUP_REPRESENTATIVE: Record<PrimGroup, string> = {
    integer: 'i32',
    float: 'f64',
    bool: 'bool',
    char: 'char',
};

// Casting map
const CAST_MAP: Record<PrimGroup, PrimGroup[]> = {
    integer: ['integer', 'float', 'bool', 'char'],
    float: ['integer', 'float'],
    char: ['integer', 'char'],
    bool: ['bool'],
};

export default class TypeChecker extends RustParserVisitor<ReturnType | null> {
    private typeStack: Type[] = [toType({valType: ValType.ROOT})];
    private variables: Variable[] = [];
    private functions: Function[] = [];
    private structs: Struct[] = [];
    private stdFunctions: Function[] = [];
    private stdStructs: SharedStruct[] = [];
    private stdTraits: Trait[] = [];
    private traits: Trait[] = [];
    private holes: Hole[] = [];

    // Type error list
    public typeErrors: { location: SourceLocation; message: string }[] = [];

    // Holes with unknown type such as let x = ??;
    private deferredHoles = new Map<number, { hole: Hole; observations: Type[]; scope: Variable[] }>();
    private nextInferenceId = 0;

    private static readonly MAX_METHOD_CHAIN_DEPTH = 1;

    private blockStack: string[] = ['global']; // Stack to track nested blocks
    private blockCounter: number = 0;          // Counter to generate unique block IDs

    // Return type of the function currently being visited (a stack to support nested functions).
    // Used so that `return ??` resolves the hole against the declared return type.
    private functionReturnTypeStack: Type[] = [];

    private currentImplType: string | null = null;

    private usageListener: UsageGraphListener;

    private ownership: boolean;

    constructor(usageListener: UsageGraphListener, stdParseResult?: StdParseResult, ownership: boolean = true) {
        super();
        this.usageListener = usageListener;
        this.ownership = ownership;

        this.loadStdLibrary(stdParseResult);
    }

    private loadStdLibrary(stdParseResult?: StdParseResult) {
        const { functions, structs, traits } = stdParseResult ?? parseStdJsonFile();
        this.stdFunctions = functions;
        this.stdStructs = structs;
        this.stdTraits = traits;
        this.loadPrelude()
    }

    loadPrelude() {
        this.stdStructs.forEach((struct) => {
            if (!struct.prelude) {
                return;
            }
            console.log("Prelude Struct: ", struct.name)

            if (!this.structs.some(s => s.name === struct.name)) {
                this.structs.push({
                    name: struct.name,
                    location: struct.location,
                    fields: [...struct.fields],
                    methods: [...struct.methods],
                    path: struct.path ?? [],
                    traits: struct.traits.map(t => ({ ...t, methods: [...t.methods] })),
                    iteratorItem: struct.iteratorItem,
                    genericParams: struct.genericParams,
                });
            }

            // Add associated functions for this struct
            this.stdFunctions
                .filter(f => f.structName === struct.name)
                .forEach(f => {
                    if (!this.functions.some(existing => existing.name === f.name && existing.structName === f.structName)) {
                            this.functions.push({ ...f, origin: FunctionOrigin.Prelude });
                        }
                    });

            return null;
        })

        // Add std functions
        this.stdFunctions
            .filter(f => f.prelude)
            .forEach((f) => {
                console.log("Prelude Function: ", f.name)
                if (!this.functions.some(existing => existing.name === f.name && existing.structName === f.structName)) {
                    this.functions.push({ ...f, origin: FunctionOrigin.Prelude });
                }
            });
        
        // Add prelude traits
        this.stdTraits
            .filter(t => t.prelude)
            .forEach((trait) => {
                console.log("Prelude Trait: ", trait.name)
                if (!this.traits.some(existing => existing.name === trait.name)) {
                    this.traits.push({ ...trait, methods: [...trait.methods] });
                }
            });
    }

    // ============================================= UTIL METHODS =============================================

    findStructFromUserImport(userImportPathString: string): SharedStruct | undefined {
        // Split "std::collections::HashSet" -> ["std", "collections", "HashSet"]
        const userSegments = userImportPathString.split('::');
        const importedTypeName = userSegments[userSegments.length - 1];

        for (const structObj of this.stdStructs) {
            if (!structObj.path || structObj.path.length === 0) continue;

            const registryTypeName = structObj.path[structObj.path.length - 1];
            if (registryTypeName !== importedTypeName) continue;

            if (this.isPathMatch(userSegments, structObj.path)) {
                return structObj;
            }
        }
        return undefined;
    }

    findFunctionFromUserImport(userImportPathString: string): Function | undefined {
        const userSegments = userImportPathString.split('::');
        const importedName = userSegments[userSegments.length - 1];

        return this.stdFunctions.find(f => {
            if (f.name !== importedName || !f.path || f.path.length === 0) return false;
            return this.isPathMatch(userSegments, f.path);
        });
    }

    isPathMatch(userPath: string[], registryPath: string[]): boolean {
        const userTypeName = userPath[userPath.length - 1];
        const registryTypeName = registryPath[registryPath.length - 1];
        
        if (userTypeName !== registryTypeName) return false;

        if (userPath.includes("collections") && (registryPath.includes("collections") || registryPath.includes("hashbrown"))) {
            return true;
        }

        const commonModule = userPath[userPath.length - 2];
        return registryPath.includes(commonModule);
    }

    private collectUseTreeLeaves(tree: any, prefix: string): string[] {
        if (!tree) return [];

        const segmentText: string = tree.simplePath()?.getText() ?? '';
        const currentPrefix = prefix && segmentText ? `${prefix}::${segmentText}` : (segmentText || prefix);

        if (tree.STAR()) {
            return [];
        }

        const nestedTrees = tree.useTree();
        if (tree.LCURLYBRACE() && Array.isArray(nestedTrees) && nestedTrees.length > 0) {
            return nestedTrees.flatMap((child: any) => this.collectUseTreeLeaves(child, currentPrefix));
        }

        return currentPrefix ? [currentPrefix] : [];
    }

    private importUserPath(normalizedPath: string) {
        const foundStruct = this.findStructFromUserImport(normalizedPath);

        if (foundStruct) {
            console.log(`User import: ${normalizedPath} -> Found struct: ${foundStruct.name}`);

            if (!this.structs.some(s => s.name === foundStruct.name)) {
                this.structs.push({
                    name: foundStruct.name,
                    location: foundStruct.location,
                    fields: [...foundStruct.fields],
                    methods: [...foundStruct.methods],
                    path: foundStruct.path ?? [],
                    traits: foundStruct.traits.map(t => ({ ...t, methods: [...t.methods] })),
                    iteratorItem: foundStruct.iteratorItem,
                });
            }

            // Add associated functions
            this.stdFunctions
                .filter(f => f.structName === foundStruct.name)
                .forEach(f => {
                    if (!this.functions.some(existing => existing.name === f.name && existing.structName === f.structName)) {
                        this.functions.push({ ...f, origin: FunctionOrigin.StdImport });
                    }
                });
            return;
        }

        const foundFunction = this.findFunctionFromUserImport(normalizedPath);
        if (foundFunction) {
            console.log(`User import: ${normalizedPath} -> Found function: ${foundFunction.name}`);

            if (!this.functions.some(existing => existing.name === foundFunction.name && existing.structName === foundFunction.structName)) {
                this.functions.push({ ...foundFunction, origin: FunctionOrigin.StdImport });
            }
            return;
        }

        console.log(`User import: ${normalizedPath} -> Found nothing`);
    }

    visitUseDeclaration = (ctx: any): ReturnType | null => {
        const topTree = ctx.useTree();
        if (!topTree) return null;

        this.collectUseTreeLeaves(topTree, '').forEach(rawPath => {
            const normalizedPath = rawPath.startsWith('::') ? rawPath.slice(2) : rawPath;
            this.importUserPath(normalizedPath);
        });

        return null;
    }

    saveState() {
        return { variables: this.variables.map(cloneVariable) }
    }

    loadState(state: any) {
        this.variables = state.variables.map(cloneVariable);
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


    getBoundVariable(variableName: string): Variable | undefined {
        const variable = this.variables.findLast(variable => (variable.name === variableName)) // Find last temporary fix for shadowing
        if(variable) {
            return variable;
        } else {
            // throw Error("Variable not bound")
            return undefined;
        }
    }

    getBoundFunction(functionName: string, structName: string | null = null): Function | undefined {
        const function_ = this.functions.find(function_ => (function_.name === functionName && (structName ? function_.structName === structName : true)))
        return function_;
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

    private reportTypeError(location: SourceLocation, message: string): void {
        console.log("Type error:", message);
        this.typeErrors.push({ location, message });
    }

    // Start tracking a hole as deferred, to be hopefully filled later
    // e.g. let x = ??;
    private deferHole(location: SourceLocation): number | undefined {
        const key = getSourceLocationKey(location);
        const hole = this.holes.find(h => getSourceLocationKey(h.location) === key);
        if (!hole) return undefined;

        const id = this.nextInferenceId++;
        
        this.deferredHoles.set(id, { hole, observations: [], scope: this.variables.map(cloneVariable) });
        return id;
    }

    // Check if variable used is deferred and record new type if yes
    private observeDeferredUse(variableType: Type | undefined, type: Type | undefined): void {
        if (variableType?.inferenceId === undefined || variableType.valType !== ValType.UNKNOWN) return;

        const deferred = this.deferredHoles.get(variableType.inferenceId);
        const observed = type?.reportAs ?? type;
        if (!deferred || !observed) return;

        const uninformative = [ValType.UNKNOWN, ValType.VOID, ValType.HOLE, ValType.ROOT];
        if (uninformative.includes(observed.valType)) return;

        deferred.observations.push(observed);
    }

    // Re-resolve deferred holes based on new types and context snapshot
    private resolveDeferredHoles(): void {
        for (const { hole, observations, scope } of this.deferredHoles.values()) {
            const inferred = observations[0];
            if (!inferred) continue;

            const outerScope = this.variables;
            this.variables = scope;
            hole.type = toType({...inferred, inferenceId: undefined, methodCall: false});
            this.computeHoleSuggestions(hole);
            this.variables = outerScope;
        }
    }

    private methodsOf(struct: Struct, receiverType?: Type): Function[] {
        const bindings = this.genericBindings(struct, receiverType);
        const selfArgument = this.typeArgumentOf(receiverType);
        return getAllMethods(struct).map(m => substituteInFunction(m, struct.name, bindings, selfArgument));
    }

    
    private genericBindings(struct: Struct | undefined, receiverType: Type | undefined): Record<string, Type> {
        const firstParam = struct?.genericParams?.[0];
        const argument = this.typeArgumentOf(receiverType);
        if (!firstParam || !argument) return {};

        return { [firstParam]: argument };
    }

    private typeArgumentOf(receiverType: Type | undefined): Type | undefined {
        const receiver = receiverType?.valType === ValType.REFERENCE ? receiverType.elementType : receiverType;
        const argument = receiver?.elementType;
        return argument && argument.valType !== ValType.UNKNOWN ? argument : undefined;
    }

    getBoundMethod(structName: string, identifier: string, receiverType?: Type): Function | null {
        const struct = this.structs.find(s => s.name === structName);
        const bindings = this.genericBindings(struct, receiverType);
        const selfArgument = this.typeArgumentOf(receiverType);

        if (struct) {
            const method = getAllMethods(struct).findLast(m => m.name === identifier);
            if (method) return substituteInFunction(method, structName, bindings, selfArgument);
        }

        for (const s of this.structs) { // TODO Separate into function
            const trait = s.traits.find(t => t.name === structName);
            const method = trait?.methods.find(m => m.name === identifier);
            if (method) return substituteInFunction(method, structName, bindings, selfArgument);
        }

        return null;
    }

    borrow(variableName: string, mutable: boolean, location: SourceLocation): Variable | undefined {
        const variable = this.getBoundVariable(variableName);
        if (!variable) {
            return variable;
        }

        if (this.ownership) {
            if (variable.type?.borrows === Borrow.BFree) {
                variable.type.borrows = mutable ? Borrow.BMut : Borrow.BImmut
            } else if (variable.type?.borrows === Borrow.BMut && !this.checkBorrows(variable.type.owner!, location)) {
                throw Error("Cannot borrow, already mutably borrowed")
            } else {
                if (mutable && !this.checkBorrows(variable.type.owner!, location)) {
                    throw Error("Cannot mutably borrow, already immutably borrowed")
                }
            }
        }
        variable.type.mutableReference = mutable;
        return variable;
    }

    consume(variableName: string) {
        if (!this.ownership) {
            return
        }

        const variable = this.getBoundVariable(variableName)

        if (!variable) {
            return
        }

        if (variable.type.primitive || variable.type.valType === ValType.REFERENCE || variable.type.valType === ValType.UNKNOWN) {
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

        if (!genericArgs) {
            const genericMatch = typeString.match(/^([a-zA-Z_][a-zA-Z0-9_]*)<(.+)>$/);
            if (genericMatch) {
                return this.parseStringType(genericMatch[1], genericMatch[2]);
            }
        }

        if (genericArgs) {
            let elementType : Type | undefined = this.parseStringType(genericArgs);
            elementType = elementType.valType === ValType.UNKNOWN ? undefined : elementType
            return toType({valType: ValType.STRUCT, structName: typeString, elementType: elementType});
        }
        
        if (typeString.startsWith('(') && typeString.endsWith(')') && typeString.length > 2) {
            const members = splitTopLevel(typeString.slice(1, -1), ',');
            if (members.length > 1) {
                return toType({valType: ValType.TUPLE, elementTypes: members.map(m => this.parseStringType(m.trim()))});
            }
        }

        const nestedRefMatch = typeString.match(/^&\s*(mut\s+)?(&.*)$/);
        if (nestedRefMatch) {
            const elementType = this.parseStringType(nestedRefMatch[2]);
            return toType({valType: ValType.REFERENCE, elementType: elementType, mutableReference: nestedRefMatch[1] !== undefined, structName: elementType.structName});
        }

        const refMatch = typeString.match(/^(&)?\s*(mut)?\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:<([^>]+)>)?$/);

        if (refMatch && refMatch[1] === '&') {
            const mutableReference = refMatch[2] === 'mut' ? true : false;
            const elementType = this.parseStringType(refMatch[3], refMatch[4]);

            return toType({valType: ValType.REFERENCE, elementType: elementType, mutableReference: mutableReference, structName: elementType.structName});
        }

        // Check if it's a struct type. Primitives ("i32", "f32", "bool", "str", ...) land here too:
        // they are registered as prelude structs, so they need no separate branch.
        if (this.structs.some(s => s.name === typeString)) {
            return toType({valType: ValType.STRUCT, structName: typeString});
        }

        if (typeString === 'Self') {
            return toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
        }

        return toType({valType: ValType.UNKNOWN});
    }

    checkBorrows(owner: Variable, location: SourceLocation, variableName: string | null = null): boolean {
        if (!this.ownership) {
            return true;
        }

        if (owner) {
            const borrows = this.variables.filter(v => v.type.owner === owner && v !== owner)

            if (!borrows.every(v => v.name === variableName || this.usageListener.isVariableFree(v.name, this.getCurrentBlock(), location.line))) {
                return false;
            }
        }
        return true;
    }

    canBeAssigned(assignee: Type, assigned: Type, owner: Variable | null = null, checkMutability: boolean = true, debug: boolean = false): boolean {
        if (!assignee) {
            return false;
        }

        if (assignee.valType === 'trait') {
            const matchinStructs = [...this.structs, ...this.stdStructs].filter(s => s.traits.some(t => t.name === assignee.structName))
            return matchinStructs.some(s => this.canBeAssigned(toType({...assignee, valType: ValType.STRUCT, structName: s.name}), assigned, owner, checkMutability))
        }
        if (checkMutability && assignee.mutable && !assigned.mutable) {
            return false;
        }
        
        // Primitives are Copy, so they can never be blocked by the borrow/move checks below.
        if (assigned.primitive && typesEqual(assignee, assigned)) {
            return true;
        }
        
        if (assigned.borrows === Borrow.BMut) {
            if (owner && !this.checkBorrows(owner, owner.location)) {
                return false;
            }
        } else if (assigned.borrows === Borrow.BImmut && ((assignee.valType === ValType.REFERENCE && assignee.mutableReference) || assignee.valType !== ValType.REFERENCE)  ) {
            if (owner && !this.checkBorrows(owner, owner.location)) {
                return false;
            }
        }
        
        if (assignee.valType === ValType.UNKNOWN) {
            return true;
        }
        
        if (assignee.valType === ValType.TUPLE || assigned.valType === ValType.TUPLE) {
            return typesEqual(assignee, assigned);
        }

        if (assignee.valType === ValType.REFERENCE && assignee.methodCall) {
            if (assignee.mutableReference && !assigned.mutableReference) {
                return false;
            }
            return assignee.elementType !== undefined && this.receiverMatch(assignee.elementType, assigned) > 0;
        }

        if (assignee.valType === assigned.valType
                || (assigned.structName === 'String' && assignee.structName === 'str')
            ) {    // TODO hacky string coercion
            if (assignee.valType === ValType.VECTOR ) {
                return typesEqual(assignee.elementType, assigned.elementType);
            } else if (assignee.valType === ValType.REFERENCE) {
                if (assignee.mutableReference && !assigned.mutableReference) {
                    return false;
                }
                return typesEqual(assignee.elementType, assigned.elementType)
                    || (assigned.structName === 'str' && assignee.structName === 'String')    // TODO hacky string coercion;
            } else if (assignee.valType === ValType.STRUCT) {
                if (!structNamesCompatible(assignee.structName, assigned.structName)) return false;
                return typesEqual(assignee.elementType, assigned.elementType); // TODO: check if elementType exists
            }
            return true;
        }

        return false;
    }

    // Try to find type from parent context
    private numericLiteralType(defaultName: string): Type {
        const expected = this.currentParentType;
        const contextual = expected.valType === ValType.STRUCT &&
            structNamesCompatible(defaultName, expected.structName);
        return primitiveType(contextual ? expected.structName! : defaultName);
    }

    // ============================================= VISIT METHODS =============================================

    visitLiteralExpression = (ctx: any): ReturnType => {
        console.log("Literal Expression")
        
        if (ctx.FLOAT_LITERAL()) {
            return {
                type: this.numericLiteralType('f64'),
                location: getLocation(ctx)
            };
        }

        if (ctx.INTEGER_LITERAL()) {
            return {
                type: this.numericLiteralType('i32'),
                location: getLocation(ctx)
            };
        }

        if (ctx.STRING_LITERAL() || ctx.RAW_STRING_LITERAL()) {
            return {
                type: toType({
                    valType: ValType.REFERENCE,
                    elementType: primitiveType('str'),
                    structName: 'str'
                }),
                location: getLocation(ctx)
            };
        }

        if (ctx.KW_TRUE() || ctx.KW_FALSE()) {
            return {
                type: primitiveType('bool'),
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
            methods: [],
            traits: []
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

        struct?.traits.push({ name: ctx.typePath().getText(), location: getLocation(ctx), methods: [], path: [] });

        return null;
    };

    private visitTupleAssignment(left: any, right: any): ReturnType | null {
        const leftElements: any[] = left.tupleElements()?.expression() ?? [];
        const rightElements: any[] = right instanceof TupleExpressionContext
            ? right.tupleElements()?.expression() ?? []
            : [];

        if (leftElements.length === 0 || leftElements.length !== rightElements.length) {
            this.visit(right);
            this.visit(left);
            return null;
        }

        const rightTypes = rightElements.map(element => this.visit(element)?.type ?? toType({valType: ValType.UNKNOWN}));

        leftElements.forEach((element, i) => {
            const target = this.getBoundVariable(element.getText());
            if (target && !target.type.mutable && !target.type.mutableReference) {
                this.reportTypeError(getLocation(element), `Cannot modify immutable variable ${element.getText()}`);
            }

            this.typeStack.push(rightTypes[i]);
            this.visit(element);
            this.typeStack.pop();

            if (target) {
                target.location = getLocation(element);
            }
        });

        return null;
    }

    visitTupleExpression = (ctx: TupleExpressionContext): ReturnType => {
        console.log("Tuple expression")

        const elements: any[] = ctx.tupleElements()?.expression() ?? [];
        const expected = this.currentParentType;
        const expectedMembers = expected?.valType === ValType.TUPLE ? expected.elementTypes ?? [] : [];

        const elementTypes = elements.map((element, i) => {
            this.typeStack.push(expectedMembers[i] ?? toType({valType: ValType.UNKNOWN}));
            const visited = this.visit(element)?.type;
            this.typeStack.pop();
            return visited ?? toType({valType: ValType.UNKNOWN});
        });

        return {
            type: toType({valType: ValType.TUPLE, elementTypes: elementTypes}),
            location: getLocation(ctx)
        };
    }

    visitAssignmentExpression = (ctx: any): ReturnType | null => {
        console.log("Assignment expression")
        const leftHandExpression = ctx.expression(0);
        const rightHandExpression = ctx.expression(1);

        let variable;
        let varType = toType({valType: ValType.UNKNOWN});

        if (leftHandExpression.getText() === '??') {
            const right = this.visit(rightHandExpression) as ReturnType;
            this.typeStack.push(right.type || toType({valType: ValType.UNKNOWN}));
            this.visit(leftHandExpression) as ReturnType;
            this.typeStack.pop()
            return null
        }
        
        if (leftHandExpression instanceof TupleExpressionContext) {
            return this.visitTupleAssignment(leftHandExpression, rightHandExpression);
        }

        if (leftHandExpression instanceof FieldExpressionContext) {
            variable = this.getBoundVariable(leftHandExpression.expression().getText());
            varType = variable ? this.getBoundField(variable.type.structName!, leftHandExpression.identifier().getText()).type : toType({valType: ValType.UNKNOWN})
        } else if (leftHandExpression instanceof IndexExpressionContext) {
            const baseName = leftHandExpression.expression(0)!.getText();
            variable = this.getBoundVariable(baseName);
            varType = variable?.type.elementType ?? toType({valType: ValType.UNKNOWN});

            if (!variable) {
                varType = this.visit(leftHandExpression.expression(0)!)?.type?.elementType ?? varType;
            }
            const indexExpression = leftHandExpression.expression(1);
            if (indexExpression) {
                this.typeStack.push(primitiveType('usize'));
                this.visit(indexExpression);
                this.typeStack.pop();
            }
        } else if (leftHandExpression instanceof DereferenceExpressionContext) {
            variable = this.visit(leftHandExpression.expression())!.type!.owner
            varType = variable?.type ?? toType({valType: ValType.UNKNOWN});
        } else {
            const variableName = leftHandExpression.getText();
            variable = this.getBoundVariable(variableName)
            varType = variable?.type ?? toType({valType: ValType.UNKNOWN})
        }



        if (variable && !variable.type.mutable && !variable.type.mutableReference) {
            throw Error("Cannot modify immutable variable", ctx.expression(0).getText())
        }

        if (varType) {
            this.typeStack.push(varType);
        }

        let inferedType: Type = toType({valType: ValType.UNKNOWN});
        if (rightHandExpression) {
            inferedType = this.visit(rightHandExpression)?.type as Type;
        }

        if(rightHandExpression instanceof PathExpression_Context && rightHandExpression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(rightHandExpression.getText())
        }

        if(variable){
            variable.location = getLocation(ctx);
        }

        if (varType) {
            this.typeStack.pop();
        }

        return null
    }

    visitCompoundAssignmentExpression = (ctx: any): ReturnType | null => {
        console.log("Compound Assignment")
        return this.visitAssignmentExpression(ctx);
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
            inferedType = toType({valType: ValType.UNKNOWN, ...this.visit(expression)?.type});
        }
        
        // Defer unknown holes
        let deferredId: number | undefined;
        if (inferedType.valType === ValType.HOLE && declaredType.valType == ValType.UNKNOWN) {
            deferredId = this.deferHole(getLocation(expression));
            if (deferredId === undefined) {
                recordVar = false;
            } else {
                inferedType = toType({valType: ValType.UNKNOWN, inferenceId: deferredId});
            }
        }
        
        if(expression instanceof PathExpression_Context && expression?.pathExpression()?.pathInExpression()?.pathExprSegment(0)?.pathIdentSegment().identifier()) { // a variable is being assigned
            this.consume(expression.getText())
        }
        
        this.typeStack.pop();
        // console.log("Inferred type: ", inferedType, "Declared type: ", declaredType)
        
        if (declaredType.valType !== ValType.UNKNOWN &&
            (inferedType.valType === ValType.HOLE || inferedType.elementType?.valType === ValType.HOLE)) {
            inferedType = declaredType;
        } else if (!typesEqual(declaredType, inferedType)) {
            this.reportTypeError(getLocation(ctx), "Declared type is different from infered type: "
                + declaredType.toTypeString() + " vs " + inferedType.toTypeString());
            inferedType = declaredType;
        }

        if (recordVar) {
            // The annotation wins whenever it says more than the expression did
            const declaredElement = declaredType.elementType;
            const inferredElement = inferedType.elementType;
            const declarationIsMoreSpecific = declaredElement !== undefined
                && declaredElement.valType !== ValType.UNKNOWN
                && (inferredElement === undefined || inferredElement.valType === ValType.UNKNOWN);

            let valType = inferedType;
            if (deferredId === undefined && (inferedType.valType === ValType.UNKNOWN || declarationIsMoreSpecific)) {
                valType = declaredType;
            }
            
            const type = toType(valType);
            type.mutable = mutable;
            
            const variable: Variable = {name: variableName, type: type, location: getLocation(ctx)};
            
            this.variables.push(variable)
        }
        return null;
    }

    visitMacroInvocation = (ctx: any): ReturnType | null => {
        console.log("Macro invocation")
        if (ctx.simplePath().getText() === "vec") {
            const type = toType({valType: ValType.VECTOR, elementType: this.vecMacroElementType(ctx)});

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

    // Parse a vector macro and return element type
    private vecMacroElementType(ctx: any): Type {
        const unknown = toType({valType: ValType.UNKNOWN});
        
        // Too complicated; out of scope
        if (ctx.delimTokenTree().tokenTree().length !== 1) return unknown;

        const tokens = ctx.delimTokenTree().tokenTree(0)?.tokenTreeToken();
        if (!tokens || tokens.length === 0) return unknown;

        // vec![element; count]
        const semicolon = tokens.findIndex((t: any) => t.getText() === ';');
        const elements = semicolon >= 0
            ? [tokens.slice(0, semicolon)]
            : splitOn(tokens, ',');
        if (semicolon >= 0) {
            tokens.slice(semicolon + 1).forEach((t: any) => this.visit(t));
        }

        // vec![] or vec![element1, element2, ...]
        let elementType: Type = unknown;
        for (const element of elements) {
            if (element.length !== 1) return unknown;

            const visited = this.visit(element[0])?.type;
            if (!visited || visited.valType === ValType.UNKNOWN) continue;

            if (elementType.valType === ValType.UNKNOWN) {
                elementType = visited;
            } else if (!typesEqual(elementType, visited)) {
                this.reportTypeError(getLocation(ctx), "All elements in vec must be of same type");
                return unknown;
            }
        }

        return elementType;
    }

    private visitCallArguments(callParams: any, paramTypeAt: (index: number) => Type | undefined): void {
        callParams?.expression().forEach((expr: any, i: number) => {
            const paramType = paramTypeAt(i);
            this.typeStack.push(paramType ?? toType({valType: ValType.UNKNOWN}));
            const argumentType = this.visit(expr)?.type;
            
            this.observeDeferredUse(argumentType, paramType);
            if (expr instanceof PathExpression_Context) {
                this.consume(expr.getText());
            }
            this.typeStack.pop();
        });
    }

    visitCallExpression = (ctx: any): ReturnType | null => {
        console.log("Call expression")
        let structName = null;
        let functionName = null;

        const pathSegments = ctx.expression()?.pathExpression?.()?.pathInExpression()?.pathExprSegment() ?? [];

        if (pathSegments.length > 1) {
            structName = pathSegments[0]?.pathIdentSegment()?.identifier()?.getText()
            functionName = pathSegments[1]?.pathIdentSegment()?.identifier()?.getText()

        } else {
            functionName = pathSegments[0]?.pathIdentSegment()?.identifier()?.getText()
        }

        console.log("Function call:", functionName, "Struct:", structName)
        let func = functionName ? this.getBoundFunction(functionName, structName) : undefined;

        let matchedTraitName: string | null = null; // TODO Should go in bound function
        if (!func && functionName && structName) {
            const implementors = this.structs.filter(s => s.traits.some(t => t.name === structName));
            func = this.functions.find(f => f.name === functionName && implementors.some(s => s.name === f.structName));
            if (func) matchedTraitName = structName;
        }

        this.visitCallArguments(ctx.callParams(), i => func?.params[i]?.type);

        if (!func) {
            return { type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
        }

        if (matchedTraitName) {
            return { type: toType({valType: ValType.TRAIT, structName: matchedTraitName}), location: getLocation(ctx) };
        }

        return { type: func.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
    }

    // Get the structs that implement a trait
    private expandTraitType(type: Type): Type[] {
        const traitType = type.valType === ValType.REFERENCE ? type.elementType : type;
        if (traitType?.valType !== ValType.TRAIT) return [];

        return [...this.structs, ...this.stdStructs]
            .filter(s => s.traits.some(t => t.name === traitType.structName))
            .map(s => toType({...traitType, valType: ValType.STRUCT, structName: s.name, candidateTypes: undefined}));
    }

    // Candidates for the method receiver type ranked by expected result and available bindings of the type
    private receiverCandidates(methodName: string, expectedResultType: Type | undefined): { expected: Type; reported: Type }[] {
        const inScope = this.variables.filter(v => !v.type.consumed);

        const scored = this.structs.flatMap(struct => {
            const method = this.methodsOf(struct).find(m => m.name === methodName);
            if (!method || method.params.length === 0) return [];

            const traitName = struct.methods.some(m => m.name === methodName)
                ? undefined
                : struct.traits.find(t => t.methods.some(m => m.name === methodName))?.name;
            const receiverStructType = traitName
                ? toType({valType: ValType.TRAIT, structName: traitName})
                : toType({valType: ValType.STRUCT, structName: struct.name});

            const selfParam = method.params[0].type;
            const expected = selfParam.valType === ValType.REFERENCE
                ? toType({methodCall: true, valType: ValType.REFERENCE, elementType: receiverStructType, mutable: selfParam.mutable, mutableReference: selfParam.mutableReference})
                : toType({methodCall: true, valType: receiverStructType.valType, structName: receiverStructType.structName, mutable: selfParam.mutable});

            const resultFits = expectedResultType && expectedResultType.valType !== ValType.UNKNOWN && method.type
                && this.canBeAssigned(expectedResultType, method.type, null, false);
            const resultScore = resultFits ? 1 : 0;

            if (receiverStructType.valType === ValType.TRAIT) {
                const evidence = Math.max(0, ...inScope.map(v => this.receiverMatch(receiverStructType, v.type)));
                return [{ expected, reported: receiverStructType, score: evidence + resultScore }];
            }

            const matches = inScope
                .map(v => ({ variable: v, evidence: this.receiverMatch(receiverStructType, v.type) }))
                .filter(m => m.evidence > 0)
                .sort((a, b) => b.evidence - a.evidence);

            if (matches.length === 0) {
                return [{ expected, reported: receiverStructType, score: resultScore }];
            }

            const seen = new Set<string>();
            return matches.flatMap(({ variable, evidence }) => {
                const reported = toType({...variable.type, owner: undefined, consumed: false, mutable: false});
                const key = reported.toTypeString();
                if (seen.has(key)) return [];
                seen.add(key);
                return [{ expected, reported, score: evidence + resultScore }];
            });
        });

        // Stable within a score, so the existing declaration order still breaks ties.
        return scored.sort((a, b) => b.score - a.score);
    }

    private receiverMatch(receiverStructType: Type, variableType: Type): number {
        const actual = variableType.valType === ValType.REFERENCE ? variableType.elementType : variableType;
        if (!actual?.structName) return 0;

        if (receiverStructType.valType === ValType.TRAIT) {
            const struct = [...this.structs, ...this.stdStructs].find(s => s.name === actual.structName);
            return struct?.traits.some(t => t.name === receiverStructType.structName) ? 2 : 0;
        }

        if (structNamesCompatible(receiverStructType.structName, actual.structName)) return 4;

        const derefsTo: Record<string, string> = { String: 'str', Vec: 'slice' };
        return derefsTo[actual.structName] === receiverStructType.structName ? 2 : 0;
    }

    visitMethodCallExpression = (ctx: any): ReturnType | null => {
        console.log("MethodCallExpression");
        
        const receiver = ctx.expression();
        const methodSegment = ctx.pathExprSegment();
        const methodName = methodSegment?.pathIdentSegment()?.identifier()?.getText();

        console.log("Method name: ", methodName)

        this.visit(methodSegment?.pathIdentSegment()?.identifier())

        const candidates = this.receiverCandidates(methodName, this.currentParentType);

        if (candidates.length > 0) {
            const [best, ...rest] = candidates;
            const expected = cloneType(best.expected);
            expected.reportAs = best.reported;
            expected.candidateTypes = rest.map(c => c.reported);
            this.typeStack.push(expected);
        } else {
            this.typeStack.push(toType({valType: ValType.UNKNOWN}));
        }

        let receiverType = toType({valType: ValType.UNKNOWN});

        if (receiver) {
            const visitedReceiver = this.visit(receiver)
            receiverType = visitedReceiver?.type || receiverType;

        }

        this.observeDeferredUse(receiverType, this.currentParentType);
        this.typeStack.pop();

        const structName = receiverType?.structName;
        if (!methodName) {
            throw new Error("Unable to resolve method name for MethodCallExpression");
        }

        const func = structName ? this.getBoundMethod(structName, methodName, receiverType) : null;

        if (func) {
            console.log("Method call:", func.name, "on struct", structName);

            // Consume method receiver only if the method takes owned variable
            if (func.params[0].type.valType !== ValType.REFERENCE) {
                this.consume(receiver.getText())
            }
        }

        this.visitCallArguments(ctx.callParams(), i => func?.params[i + 1]?.type);

        if (!func) {
            return { type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
        }

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

        const patternWithoutRange = ctx.pattern().patternNoTopAlt(0).patternWithoutRange();

        let pattern = patternWithoutRange.identifierPattern?.();
        if (!pattern) {
            pattern = patternWithoutRange.referencePattern()?.patternWithoutRange().identifierPattern();
        }
        const tuplePattern = !pattern ? patternWithoutRange.tuplePattern?.() : null;

        if (!pattern && !tuplePattern && !patternWithoutRange.wildcardPattern()) {
            throw new Error("Only simple identifier patterns, wildcard patterns or tuple patterns are supported in for loops")
        }

        const currentState = this.saveState();

        if (pattern) {
            const variableName = pattern.identifier().getText();
            const mutable = pattern.KW_MUT() != null;

            const iteratorType = this.visitIterable(ctx.expression());
            let elementType = toType({valType: ValType.UNKNOWN});

            if ((iteratorType.valType === ValType.STRUCT && iteratorType.structName === "Vec") ||iteratorType.valType === ValType.VECTOR || iteratorType.valType === ValType.RANGE) {
                elementType = iteratorType.elementType ?? toType({valType: ValType.UNKNOWN});
            } else if (iteratorType.valType === ValType.REFERENCE && iteratorType.elementType?.valType === ValType.VECTOR) {
                elementType = iteratorType.elementType ?? toType({valType: ValType.UNKNOWN});
            } else if (iteratorType.valType === ValType.STRUCT && iteratorType.structName) {
                const struct = this.structs.find(s => s.name === iteratorType.structName)
                            ?? this.stdStructs.find(s => s.name === iteratorType.structName);
                if (struct?.iteratorItem) {
                    elementType = struct.iteratorItem;
            }
            }

            const loopVariable: Variable = {
                name: variableName,
                type: elementType,
                location: getLocation(pattern)
            };
            loopVariable.type.mutable = mutable;
            this.variables.push(loopVariable);
        } else if (tuplePattern) {
            this.visitIterable(ctx.expression()); // Unhandled for tuples
            const subPatterns: any[] = tuplePattern.tuplePatternItems()?.pattern() ?? [];
            for (const subPat of subPatterns) {
                const idPat = subPat.patternNoTopAlt(0)?.patternWithoutRange()?.identifierPattern?.();
                if (idPat) {
                    const loopVariable: Variable = {
                        name: idPat.identifier().getText(),
                        type: toType({valType: ValType.UNKNOWN}),
                        location: getLocation(idPat)
                    };
                    loopVariable.type.mutable = idPat.KW_MUT() != null;
                    this.variables.push(loopVariable);
                }
            }
        } else {
            this.visitIterable(ctx.expression());
        }

        this.typeStack.push(toType({valType: ValType.VOID}))

        this.visit(ctx.blockExpression());

        this.typeStack.pop()

        this.loadState(currentState);

        return {
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    }

    private visitIterable(expression: any): Type {
        if (!expression) return toType({valType: ValType.UNKNOWN});

        this.typeStack.push(toType({valType: ValType.TRAIT, structName: 'IntoIterator'}));
        const visited = this.visit(expression)?.type;
        this.typeStack.pop();

        return visited ?? toType({valType: ValType.UNKNOWN});
    }

    visitFieldExpression = (ctx: any): ReturnType | null => {
        console.log("FieldExpression");

        const receiver = ctx.expression();
        const fieldName = ctx.identifier()?.getText();

        const visitedField = this.visit(ctx.identifier())

        const variable = this.getBoundVariable(receiver.getText());

        if (visitedField?.type?.valType === ValType.HOLE) {
            const hole = {location: getLocation(ctx.identifier()), type: this.currentParentType, suggestions: []}
            variable ? this.generateStructHole(hole, variable) : {}
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
            console.log("Function call:", func?.name)
            return { type: func?.type || toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
        } else {
            const variable = this.getBoundVariable(ctx.getText());
            console.log("Variable:", variable?.name)
            const type = variable ? variable.type : toType({valType: ValType.UNKNOWN})
            return { type: type, location: getLocation(ctx) };
        }
    }

    // Expressions within statements should have a void type by default
    visitExpressionStatement = (ctx: any): null => {
        console.log("Expression statement")

        this.typeStack.push(toType({valType: ValType.VOID}))
        const expr = ctx.expression() ?? ctx.expressionWithBlock()
        this.visit(expr)
        this.typeStack.pop()
        return null;
    }

    visitIfExpression = (ctx: any): ReturnType => {
        console.log("If expression")

        const currentState = this.saveState();

        this.typeStack.push(primitiveType('bool'));
        if (ctx.expression()) {
            this.visit(ctx.expression());
        }
        this.typeStack.pop();
        
        this.loadState(currentState);
        this.visit(ctx.blockExpression(0));
        
        this.loadState(currentState);

        if (ctx.KW_ELSE()) {
            if (ctx.blockExpression(1)) {
                this.visit(ctx.blockExpression(1));
            } else if (ctx.ifExpression()) {
                this.visit(ctx.ifExpression());
            } else if (ctx.ifLetExpression()) {
                this.visit(ctx.ifLetExpression());
            }
        }

        return {
            type: this.currentParentType,
            location: getLocation(ctx)
        }
    }

    visitReturnExpression = (ctx: any): ReturnType => {
        console.log("Return expression")

        const returnType = this.functionReturnTypeStack[this.functionReturnTypeStack.length - 1]
            ?? toType({valType: ValType.VOID});

        const expr = ctx.expression();
        if (expr) {
            this.typeStack.push(returnType);
            this.visit(expr);
            this.typeStack.pop();
        }

        return {
            type: toType({valType: ValType.VOID}),
            location: getLocation(ctx)
        };
    }

    visitPredicateLoopExpression = (ctx: any): ReturnType => {
        console.log("PredicateLoopExpression")

        // Conditions i a boolean
        this.typeStack.push(primitiveType('bool'));
        if (ctx.expression()) {
            this.visit(ctx.expression());
        }
        this.typeStack.pop();

        // Body has no type, so void
        this.typeStack.push(toType({valType: ValType.VOID}));
        this.visit(ctx.blockExpression());
        this.typeStack.pop();

        return {
            type: toType({valType: ValType.UNKNOWN}),
            location: getLocation(ctx)
        };
    }

    visitComparisonExpression = (ctx: any): ReturnType => {
        console.log("Comparison expression")

        const leftChild = ctx.expression(0);
        const rightChild = ctx.expression(1);

        if (!leftChild || !rightChild) {
            return { type: toType({valType: ValType.UNKNOWN}), location: getLocation(ctx) };
        }

        let left: ReturnType;
        let right: ReturnType;

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

        return { type: primitiveType('bool'), location: getLocation(ctx) };
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
        this.functionReturnTypeStack.push(type);
        
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
                    type.elementType = toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
                    type.mutableReference = true;
                } else {
                    type.mutable = true;
                }
            } else {
                if(selfParam.shorthandSelf().AND()) {
                    type.valType = ValType.REFERENCE;
                    type.elementType = toType({valType: ValType.STRUCT, structName: this.currentImplType ?? 'unknown'});
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
            params: paramsParsed || [],
            origin: FunctionOrigin.Local
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
        this.functionReturnTypeStack.pop();
        
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
        
        const expr = ctx.expression();
        if (expr) {
            this.visit(expr);
        }

        return {
            type: type,
            location: getLocation(ctx)
        }
    };

    visitTypeCastExpression = (ctx: TypeCastExpressionContext): ReturnType => {
        console.log("Type Cast Expression")
        
        const type = this.parseType(ctx.typeNoBounds());
        const operand = ctx.expression();

        if (operand.getText() === '??') {
            const location = getLocation(operand);
            const merged: Hole = { location: location, type: type, suggestions: [] };
            const seen = new Set<string>();
            for (const sourceType of this.castableSourceTypes(type)) {
                const partial: Hole = { location: location, type: sourceType, suggestions: [] };
                this.computeHoleSuggestions(partial);
                if (!merged.context) {
                    merged.context = partial.context;
                }
                for (const suggestion of partial.suggestions) {
                    const key = `${suggestion.suggestionType}:${suggestion.suggestionNameWithTypes ?? suggestion.suggestion.name}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        merged.suggestions.push(suggestion);
                    }
                }
            }
            this.holes.push(merged);
        } else {
            this.visit(operand);
        }

        return {
            type: type,
            location: getLocation(ctx)
        };
    }

    // Castable primitives
    private castableSourceTypes(target: Type): Type[] {
        const targetGroup = primGroupOf(target.structName);
        if (!targetGroup) {
            return [target];
        }
        return CAST_MAP[targetGroup].map(group => primitiveType(GROUP_REPRESENTATIVE[group]));
    }

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
            if (right.type?.valType === ValType.REFERENCE && right?.type?.elementType && ['String', 'str'].includes(right.type?.elementType?.structName || '')) {
                this.typeStack.push(right.type.elementType);
            } else {
                this.typeStack.push(right.type || toType({valType: ValType.UNKNOWN}));
            }
            left = this.visit(leftChild) as ReturnType;
        } else {
            left = this.visit(leftChild) as ReturnType;
            if (left.type?.structName === 'String') {
                this.typeStack.push(toType({valType: ValType.REFERENCE, elementType: left.type}) || toType({valType: ValType.UNKNOWN}));
            } else {
                this.typeStack.push(left.type || toType({valType: ValType.UNKNOWN}));
            }
            right = this.visit(rightChild) as ReturnType;
        }

        this.typeStack.pop();

        this.observeDeferredUse(left.type, right.type);
        this.observeDeferredUse(right.type, left.type);

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

        this.typeStack.push(primitiveType('usize'));

        const index = this.visit(ctx.expression(1)!);

        this.typeStack.pop();

        const type = array!.type?.elementType ?? toType({valType: ValType.UNKNOWN});

        // If it is a variable borrow it
        if (ctx.expression(0) instanceof PathExpression_Context) {
            this.borrow(ctx.expression(0)!.getText(), true, getLocation(ctx)) // TODO Unhardcode the mutable borrow
        }


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
            owner = this.borrow(varName, mutable, getLocation(ctx));
        }
        
        const expr = this.visit(exprCtx) as ReturnType;
        
        const type = new Type();
        type.valType = ValType.REFERENCE;
        type.elementType = expr.type!;
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

    visitDereferenceExpression = (ctx: DereferenceExpressionContext): ReturnType => {
        console.log("Dereference Expression")

        const expr = this.visit(ctx.expression());

        const type = expr?.type?.owner?.type ?? toType({valType: ValType.UNKNOWN});

        return {
            type: type,
            location: getLocation(ctx)
        };
    }

    visitRangeExpression = (ctx: any): ReturnType => {
        console.log("Range Expression")

        const type = toType({valType: ValType.UNKNOWN});

        const start = ctx.expression(0);
        const end = ctx.expression(1);

        let startParsed;
        let endParsed;

        if (start?.getText() === '??') {
            endParsed = start ? this.visit(end) as ReturnType : null;
            this.typeStack.push(endParsed?.type || toType({valType: ValType.UNKNOWN}));
            startParsed = start ? this.visit(start) as ReturnType : null;
        } else {
            startParsed = start ? this.visit(start) as ReturnType : null;
            this.typeStack.push(startParsed?.type || toType({valType: ValType.UNKNOWN}));
            endParsed = end ? this.visit(end) as ReturnType : null;
        }

        this.typeStack.pop()

        const integerBound = [startParsed?.type, endParsed?.type].find(isIntegerType);
        if (integerBound) {
            type.valType = ValType.RANGE;
            type.elementType = primitiveType(integerBound.structName!);
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
        // console.log("Alleged type:", type)
        // console.log("Location:", location)
        const hole = {location:location, type: type, suggestions: []}
        this.generateHole(hole)

        return {
            type: toType({valType: ValType.HOLE}),
            location: location
        };
    }

    public generateHole(hole: Hole) {
        console.log("beep beep Im a sheep")
        this.computeHoleSuggestions(hole);
        this.holes.push(hole);
    }

    private computeHoleSuggestions(hole: Hole) {
        const variables = this.variables;
        const functions = this.functions;

        hole.suggestions = [];
        hole.context = {
            variables: this.variables.map(cloneVariable),
            functions: this.functions.filter(f => f.origin === FunctionOrigin.Local).map(cloneFunction),
            fields: [],
            methods: []
        };

            console.log("Hole hey")
        // this.functions.forEach((f) =>
        // {console.log(f.name)})
        this.variables.forEach((f) =>
        {console.log(f.name)
            console.log(f.type)
        })
        // console.log("Variables:")
        // console.log(variables)

        // console.log("Functions:")
        // console.log(functions)
        let holeSuggestions = [] as Suggestion[];
        
        if (hole.type.valType === ValType.UNKNOWN) {
            return;
        }

        variables.forEach((variable: Variable) => {
            // console.log("Checking variable:", variable.name, "of type", variable.type)
            let suggestedAsIs = false;
            if (variable.type && this.canBeAssigned(hole.type, variable.type, variable, false) && !variable.type.consumed) {
                if (this.checkBorrows(variable.type.owner!, hole.location, variable.name)) {
                    holeSuggestions.push({suggestionType: 'variable', suggestion: variable});
                    suggestedAsIs = true;
                }
            }

            const duplicateReceiver = hole.type.methodCall && suggestedAsIs;
            if (hole.type.valType === ValType.REFERENCE && !duplicateReceiver && this.canBeAssigned(hole.type.elementType!, variable.type, null, false) && !variable.type.consumed) {
                if (hole.type.mutableReference) {
                    if (variable.type.mutable) {
                        if (variable.type.borrows === Borrow.BFree) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: (hole.type.methodCall ? "" : "&mut ") + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                        } else {
                            if (this.checkBorrows(variable, hole.location, variable.name)) {
                                holeSuggestions.push({suggestionType: 'variable', suggestion: {name: (hole.type.methodCall ? "" : "&mut ") + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                            }
                        }
                    }
                } else {
                    if (variable.type.borrows === Borrow.BFree || variable.type.borrows === Borrow.BImmut) {
                        holeSuggestions.push({suggestionType: 'variable', suggestion: {name: (hole.type.methodCall ? "" : "&") + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type, structName: variable.type.structName}), location: variable.location}});
                    } else {
                        if (this.checkBorrows(variable, hole.location, variable.name)) {
                            holeSuggestions.push({suggestionType: 'variable', suggestion: {name: (hole.type.methodCall ? "" : "&") + variable.name, type: toType({valType: ValType.REFERENCE, elementType: variable.type, structName: variable.type.structName, mutableReference: true}), location: variable.location}});
                        }
                    }
                }
            }
            if (variable.type.valType === ValType.STRUCT || ( variable.type.valType === ValType.REFERENCE && variable.type.elementType?.valType === ValType.STRUCT)) {
                const struct = this.structs.find(s => s.name === variable.type.structName);
                if (struct) {
                    // console.log("Checking struct:", struct.name)
                    struct.fields.forEach((field: Param) => {
                        if (field.type && this.canBeAssigned(hole.type, field.type)) {
                            holeSuggestions.push({suggestionType: 'field', suggestion: {...field, name: variable.name + "." + field.name, location: variable.location}});
                        }
                    });
                    this.collectMethodChainSuggestions(hole, variable.type, variable.name, variable.location, holeSuggestions, TypeChecker.MAX_METHOD_CHAIN_DEPTH);
                    const refType = new Type();
                    Object.assign(refType, variable.type);
                    refType.valType = ValType.REFERENCE;
                    refType.elementType = variable.type;
                    refType.mutableReference = variable.type.mutable;
                    if (struct.traits.some(t => t.name === "Index") && (this.canBeAssigned(hole.type, variable.type) || this.canBeAssigned(hole.type, refType))) {
                        holeSuggestions.push({suggestionType: 'slice', suggestion: {...struct, name: "&" + variable.name + "[??..??]", location: variable.location}});
                    }

                }
            }

            if (!variable.type.consumed) {
                const isIndexable =
                    variable.type.valType === ValType.VECTOR ||
                    (variable.type.valType === ValType.STRUCT && variable.type.structName === 'Vec');
                if (isIndexable && variable.type.elementType?.valType === hole.type.valType) {
                    holeSuggestions.push({suggestionType: 'index', suggestion: {...variable, name: variable.name + "[??]"}});
                }
                if (isIndexable && variable.type.elementType) {
                    this.pushReferencedExpressionSuggestion(hole, holeSuggestions, 'index', variable.type.elementType, {...variable, name: variable.name + "[??]"}, variable);
                    this.pushReferencedExpressionSuggestion(hole, holeSuggestions, 'slice', variable.type, {...variable, name: variable.name + "[??..??]"}, variable);
                }
            }
        });

        functions.forEach((func: Function) => {
            if (func.type && this.canBeAssigned(hole.type, func.type, null, false)) {
                holeSuggestions.push({suggestionType: 'function', suggestion: {...func, name: func.name, location: func.location}});
            }
            this.pushReferencedExpressionSuggestion(hole, holeSuggestions, 'function', func.type, {...func, name: func.name, location: func.location});
        })

        const rangeTraits = ['IntoIterator', 'Iterator', 'SliceIndex'];
        const expectsRange = hole.type.valType === ValType.RANGE
            || (hole.type.valType === ValType.TRAIT && rangeTraits.includes(hole.type.structName ?? ''));
        if (expectsRange) {
            const elementType = hole.type.valType === ValType.RANGE && hole.type.elementType
                ? hole.type.elementType
                : primitiveType(hole.type.structName === 'SliceIndex' ? 'usize' : 'i32');
            for (const name of ['??..??', '??..=??']) {
                holeSuggestions.push({suggestionType: 'range', suggestion: {
                    name: name,
                    type: toType({valType: ValType.RANGE, elementType: elementType}),
                    location: hole.location
                }});
            }
        }

        holeSuggestions.forEach(s => {
            if (s.suggestionType === 'function') {
                const func = s.suggestion as Function;
                let paramStringWithTypes = func.params.map((param: any) => `??: ${param.type.toTypeString()}`).join(', ')
                let paramStringWithoutTypes = func.params.map(() => `??`).join(', ')
                let name = func.name
                if (func.structName) {
                    name = `${func.structName}::${name}`
                }
                s.suggestionNameWithTypes = `${name}(${paramStringWithTypes})`
                s.suggestionNameWithoutTypes = `${name}(${paramStringWithoutTypes})`
                s.suggestionNameNoParams = `${name}()`
            } else if (s.suggestionType === 'method') {
                const method = s.suggestion as Function;
                let paramStringWithTypes = method.params.slice(1).map((param: any) => `??: ${param.type.toTypeString()}`).join(', ')
                let paramStringWithoutTypes = method.params.slice(1).map(() => `??`).join(', ')
                s.suggestionNameWithTypes = `${method.name}(${paramStringWithTypes})`
                s.suggestionNameWithoutTypes = `${method.name}(${paramStringWithoutTypes})`
                s.suggestionNameNoParams = `${method.name}()`
            } else {
                s.suggestionNameWithTypes = s.suggestion.name;
                s.suggestionNameWithoutTypes = s.suggestion.name;
                s.suggestionNameNoParams = s.suggestion.name;
            }
            const referencePrefix = s.suggestion.referencePrefix;
            if (referencePrefix) {
                s.suggestionNameWithTypes = referencePrefix + s.suggestionNameWithTypes;
                s.suggestionNameWithoutTypes = referencePrefix + s.suggestionNameWithoutTypes;
                s.suggestionNameNoParams = referencePrefix + s.suggestionNameNoParams;
            }
        });

        // Local scope first, then the rest
        const suggestionRank = (s: Suggestion): number => {
            if (s.suggestionType === 'function') {
                return (s.suggestion as Function).structName ? 2 : 0;
            }
            if (s.suggestionType === 'variable') return 0;
            return 1;
        };
        holeSuggestions.sort((a, b) => {
            const rankDiff = suggestionRank(a) - suggestionRank(b);
            if (rankDiff !== 0) return rankDiff;
            return (a.suggestionNameWithoutTypes?.length ?? 0) - (b.suggestionNameWithoutTypes?.length ?? 0); // rank by size
        });

        // Hole candidates if more than one
        hole.subTypes = [
            ...this.expandTraitType(hole.type)
        ];

        if (hole.subTypes.length === 0) delete hole.subTypes;

        if (hole.type.reportAs) {
            hole.type = hole.type.reportAs;
        }

        hole.suggestions = holeSuggestions;
    }

    private pushReferencedExpressionSuggestion(hole: Hole, holeSuggestions: Suggestion[], suggestionType: string, producedType: Type | undefined, suggestion: { name: string, location: SourceLocation }, owner: Variable | null = null) {
        if (hole.type.valType !== ValType.REFERENCE || !hole.type.elementType) return;
        if (hole.type.methodCall) return;
        if (!producedType || producedType.valType === ValType.REFERENCE) return;
        if (hole.type.mutableReference && owner && !owner.type.mutable) return;
        if (!this.canBeAssigned(hole.type.elementType, producedType, null, false)) return;
        holeSuggestions.push({suggestionType, suggestion: {
            ...suggestion,
            referencePrefix: hole.type.mutableReference ? "&mut " : "&",
            type: toType({valType: ValType.REFERENCE, elementType: producedType, structName: producedType.structName, mutableReference: hole.type.mutableReference}),
        }});
    }

    private collectMethodChainSuggestions(hole: Hole, receiverType: Type, receiverName: string, receiverLocation: SourceLocation, holeSuggestions: Suggestion[], depth: number, visitedStructNames: Set<string> = new Set()) {
        if (depth <= 0 || !receiverType) return;

        const isReference = receiverType.valType === ValType.REFERENCE;
        const structType = isReference ? receiverType.elementType : receiverType;
        if (!structType || structType.valType !== ValType.STRUCT) return;
        if (!structType.structName || visitedStructNames.has(structType.structName)) return;

        const struct = this.structs.find(s => s.name === structType.structName);
        if (!struct) return;

        const nextVisited = new Set(visitedStructNames);
        nextVisited.add(structType.structName);

        this.methodsOf(struct, receiverType).forEach((method: Function) => {
            // For reference receivers, skip methods that require an owned receiver (self by value)
            if (isReference && method.params.length > 0) {
                if (method.params[0].type.valType !== ValType.REFERENCE) return;
            }
            if (!method.type) return;

            const methodName = `${receiverName}.${method.name}`;
            if (this.canBeAssigned(hole.type, method.type, null, false)) {
                holeSuggestions.push({suggestionType: 'method', suggestion: {...method, name: methodName, location: receiverLocation}});
            }
            this.pushReferencedExpressionSuggestion(hole, holeSuggestions, 'method', method.type, {...method, name: methodName, location: receiverLocation});

            // Chain further method calls off this method's return type
            this.collectMethodChainSuggestions(hole, method.type, methodName, receiverLocation, holeSuggestions, depth - 1, nextVisited);
        });
    }

    public generateStructHole(hole: Hole, variable: Variable) {
        const structName = variable.type.structName;
        console.log("Generating struct hole for struct:", structName)
        const struct = this.structs.find(s => s.name === structName);
        if (!struct) return;
        let holeSuggestions = [] as Suggestion[];

        struct.fields.forEach((field: Param) => {
            if (field.type && this.canBeAssigned(hole.type, field.type)) {
                holeSuggestions.push({suggestionType: 'field', suggestion: field, suggestionNameWithTypes: field.name, suggestionNameWithoutTypes: field.name, suggestionNameNoParams: field.name});
            }
        });
        
        this.methodsOf(struct, variable.type).forEach((method: Function) => {
            // console.log("Checking method:", method.name)
            const methodRefType = new Type();
            Object.assign(methodRefType, variable.type);
            methodRefType.valType = ValType.REFERENCE;
            methodRefType.elementType = variable.type;
            methodRefType.mutableReference = variable.type.mutable;
            if (method.type && this.canBeAssigned(hole.type, method.type, null, false) && (this.canBeAssigned(method.params[0].type, variable.type, variable) || this.canBeAssigned(method.params[0].type, methodRefType, variable))) {
                let paramStringWithTypes = method.params.slice(1).map((param: any) => `??: ${param.type.toTypeString()}`).join(', ')
                let paramStringWithoutTypes = method.params.slice(1).map(() => `??`).join(', ')
                const suggestionNameWithTypes = `${method.name}(${paramStringWithTypes})`
                const suggestionNameWithoutTypes = `${method.name}(${paramStringWithoutTypes})`
                const suggestionNameNoParams = `${method.name}()`
                holeSuggestions.push({suggestionType: 'method', suggestion: {...method, name: method.name}, suggestionNameWithTypes, suggestionNameWithoutTypes, suggestionNameNoParams});
            }
        });
        
        hole.suggestions = holeSuggestions;
        hole.context = {
            variables: this.variables.map(cloneVariable),
            functions: this.functions.filter(f => f.origin === FunctionOrigin.Local).map(cloneFunction),
            fields: struct.fields.map(cloneParam),
            methods: getAllMethods(struct).map(cloneFunction)
        };
        this.holes.push(hole);
    }

    visitCrate = (ctx: any): ReturnType | null => {
        this.visitChildren(ctx);

        // Resolve deferred unknown holes
        this.resolveDeferredHoles();
        return null;
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