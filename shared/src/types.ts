// Primitives are not ValTypes of their own: they are STRUCT types named after themselves
// (structName "i32", "f32", "bool", ...), so every struct-shaped code path — method lookup,
// hole suggestions, field/trait resolution — applies to them without special casing.
export enum ValType {
	ROOT = "ROOT",
	HOLE = "HOLE",
	UNKNOWN = "UNKNOWN",
	VECTOR = "Vec",
	REFERENCE = "reference",
	STRUCT = "struct",
	TRAIT = "trait",
	RANGE = "range",
	VOID = "()"
}

// Built in types for std parsing
export const INTEGER_TYPE_NAMES = ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize"];
export const FLOAT_TYPE_NAMES = ["f16", "f32", "f64", "f128"];
export const PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set([...INTEGER_TYPE_NAMES, ...FLOAT_TYPE_NAMES, "bool", "char"]);
export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([...PRIMITIVE_TYPE_NAMES, "str"]);

export function isPrimitiveTypeName(name?: string): boolean {
	return name !== undefined && PRIMITIVE_TYPE_NAMES.has(name);
}

function primitiveGroup(name?: string): string | undefined {
	if (name === undefined) return undefined;
	if (INTEGER_TYPE_NAMES.includes(name)) return "integer";
	if (FLOAT_TYPE_NAMES.includes(name)) return "float";
	return undefined;
}

export function structNamesCompatible(a?: string, b?: string): boolean {
	if (a === b) return true;
	const group = primitiveGroup(a);
	return group !== undefined && group === primitiveGroup(b);
}

export enum Borrow {
	BFree,
	BMut,
	BImmut
}

export enum FunctionOrigin {
	Local = "local",             // defined in the user's own source
	StdImport = "std_import",    // brought in by a `use` that resolves to the standard library
	OtherImport = "other_import",// brought in by a `use` that resolves elsewhere
	Prelude = "prelude"          // automatically in scope via the Rust prelude
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
	methodCall?: boolean; // Hack for case of x.keys() where keys(&self)

	traits: Trait[] = [];

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
		} else if (type.valType === 'struct' || type.valType === 'trait') {
			if (type.elementType) {
				typeString += type.structName + "<" + constructTypeString(type.elementType) + ">";
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
	path?: string[]; // Full path for matching against user imports, e.g., ["core", "cmp", "max"]. Only set for free functions.
	prelude?: boolean; // True if automatically imported via the Rust prelude
	origin?: FunctionOrigin; // Where the function came from
}

export interface Struct {
	name: string;
	location: SourceLocation;
	fields: Param[];
	methods: Function[];
	path: string[]; // Full path for matching against user imports, e.g., ["std", "collections", "HashSet"]
	traits: Trait[];
	iteratorItem?: Type; // Iterator::Item, i.e. the element type yielded when iterated (e.g. char for Chars)
}

export interface Trait {
	name: string;
	location: SourceLocation;
	methods: Function[];
	path: string[]; // Full path for matching against user imports, e.g., ["std", "collections", "HashSet"]
	prelude?: boolean; // True if automatically imported via the Rust prelude
}

export interface Param {
	name: string;
	location: SourceLocation;
	type: Type;
}

export interface Hole {
	location: SourceLocation;
	type: Type;
	subTypes?: Type[]; // For traits / multiple types
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


// Flattens a struct's inherent methods together with the methods it gets from
// implemented traits, so callers doing method-call resolution don't need to know
// whether a method is inherent or trait-provided.
export function getAllMethods(struct: { methods: Function[]; traits: Trait[] }): Function[] {
	return [...struct.methods, ...struct.traits.flatMap(t => t.methods)];
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
	traits: Trait[];
	impls?: any[]; // Store raw impl data for later processing
	prelude?: boolean; // True if automatically imported via the Rust prelude
	iteratorItem?: Type; // Iterator::Item, i.e. the element type yielded when iterated (e.g. char for Chars)
}
