export enum ValType {
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

export enum Borrow {
	BFree,
	BMut,
	BImmut
}

export interface Type {
	elementType?: ValType; // For vectors and references
	valType: ValType;
	primitive: boolean;
	mutable?: boolean;
	mutableReference?: boolean; // Only for references, indicates if the reference itself is mutable (e.g., &mut T vs &T)
	consumed: boolean;
	borrows: Borrow;
	owner?: Variable;
	structName?: string; // For struct types
}


	
export function constructTypeString(type: Type): string {
	let typeString = "";
	if (type.valType === 'reference') {
		typeString += "&";
		if (type.mutableReference) {
			typeString += "mut ";
		}
		if (type.elementType === 'struct') {
			typeString += type.structName;
		} else {
			typeString += type.elementType;
		}
	} else if (type.valType === 'Vec') {
		typeString += "Vec " + type.elementType;
	} else if (type.valType === 'struct') {
		typeString += type.structName;
	} else {
		typeString += type.valType;
	}
	return typeString;
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