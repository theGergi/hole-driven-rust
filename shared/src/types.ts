export enum ValType {
	ROOT = "ROOT",
	INT = "i32",
	FLOAT = "f32",
	STRING = "str",
	HOLE = "HOLE",
	UNKNOWN = "UNKNOWN",
	VECTOR = "Vec",
	REFERENCE = "reference",
	STRUCT = "struct",
	RANGE = "range",
	VOID = "void"
}

export enum Borrow {
	BFree,
	BMut,
	BImmut
}

export class Type {
	elementType?: Type; // For vectors and references
	valType!: ValType;
	primitive!: boolean;
	mutable?: boolean;
	mutableReference?: boolean; // Only for references, indicates if the reference itself is mutable (e.g., &mut T vs &T)
	consumed!: boolean;
	borrows!: Borrow;
	owner?: Variable;
	structName?: string; // For struct types
	methodCall?: Boolean // Hack for case of x.keys() where keys(&self)

	toTypeString(): string {
		return constructTypeString(this)
	}
}

export function constructTypeString(type: Type): string {
	let typeString = "";
		if (type.valType === 'reference') {
			typeString += "&";
			if (type.mutableReference) {
				typeString += "mut ";
			}
			if (type.elementType) {
				typeString += constructTypeString(type.elementType);
			}
		} else if (type.valType === 'Vec') {
			typeString += "Vec<" + (type.elementType ? constructTypeString(type.elementType) : "?") + ">";
		} else if (type.valType === 'struct') {
			if (type.structName === 'Vec' && type.elementType) {
				typeString += "Vec<" + constructTypeString(type.elementType) + ">";
			} else {
				typeString += type.structName;
			}
		} else {
			typeString += type.valType;
		}
		return typeString;
}
	

export interface Suggestion {
	suggestionType: string;
	suggestion: any;
	suggestionNameWithTypes?: string;
	suggestionNameWithoutTypes?: string;
	suggestionNameNoParams?: string;
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
	path: string[]; // Full path for matching against user imports, e.g., ["std", "collections", "HashSet"]
	iterable?: boolean; // Indicates if the type can be iterated over
	index?: boolean; // Indicates if the type can be indexed/sliced (e.g., Vec, arrays)
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


// Helper function to format a variable as "name: type"
export function formatVariable(variable: any): string {
	return `${variable.name}: ${constructTypeString(variable.type)}`;
}

// Helper function to format a function signature as "name(??: paramTypes) -> returnType"
export function formatFunction(func: any): string {
	const paramString = func.params
		.map((param: any) => `??: ${constructTypeString(param.type)}`)
		.join(', ');
	const returnType = constructTypeString(func.type);
	let name = func.name
	if (func.structName) {
		name = `${func.structName}::${name}`
	}
	return `${name}(${paramString}) -> ${returnType}`;
}


export interface SharedStruct {
	name: string;
	location: SourceLocation;
	fields: Param[];
	methods: Function[];
	path?: string[]; // Full path e.g. ["std", "collections", "HashSet"]
	iterable?: boolean; // Indicates if the type can be iterated over
	index?: boolean; // Indicates if the type can be indexed/sliced (e.g., Vec, arrays)
	impls?: any[]; // Store raw impl data for later processing
	prelude?: boolean; // True if automatically imported via the Rust prelude
}
