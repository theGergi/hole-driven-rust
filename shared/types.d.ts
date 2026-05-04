export declare enum ValType {
    ROOT = "ROOT",
    INT = "integer",
    STRING = "string",
    HOLE = "HOLE",
    UNKNOWN = "UNKNOWN",
    VECTOR = "Vec",
    REFERENCE = "reference",
    STRUCT = "struct",
    RANGE = "range",
    VOID = "void"
}
export declare enum Borrow {
    BFree = 0,
    BMut = 1,
    BImmut = 2
}
export declare class Type {
    elementType?: ValType;
    valType: ValType;
    primitive: boolean;
    mutable?: boolean;
    mutableReference?: boolean;
    consumed: boolean;
    borrows: Borrow;
    owner?: Variable;
    structName?: string;
    toTypeString(): string;
}
export declare function constructTypeString(type: Type): string;
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
    iterable?: boolean;
    index?: boolean;
}
export interface Param {
    name: string;
    location: SourceLocation;
    type: Type;
}
export interface Hole {
    location: SourceLocation;
    type: Type;
    context?: HoleContext;
    suggestions: Suggestion[];
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
