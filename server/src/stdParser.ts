import fs from 'fs/promises';
import path from 'path';
import {
	Borrow,
	Param,
	SourceLocation,
	// Struct as SharedStruct,
	Type,
	ValType,
	Function as SharedFunction
} from '../../shared/out/types.js';

export interface SharedStruct {
	name: string;
	location: SourceLocation;
	fields: Param[];
	methods: SharedFunction[];
	iterable?: boolean; // Indicates if the type can be iterated over
	index?: boolean; // Indicates if the type can be indexed/sliced (e.g., Vec, arrays)
	impls?: any[]; // Store raw impl data for later processing
}


const stdJsonPath = path.resolve(process.cwd(), 'server', 'src', 'assets', 'std.json');

export interface StdParseResult {
	functions: SharedFunction[];
	structs: SharedStruct[];
}

const ZERO_LOCATION: SourceLocation = { line: 0, column: 0, length: 0 };

function createType(overrides: Partial<Type>): Type {
	const type = new Type();
	type.valType = overrides.valType ?? ValType.UNKNOWN;
	type.elementType = overrides.elementType;
	type.primitive = overrides.primitive ?? false;
	type.mutable = overrides.mutable ?? false;
	type.mutableReference = overrides.mutableReference ?? false;
	type.consumed = overrides.consumed ?? false;
	type.borrows = overrides.borrows ?? Borrow.BFree;
	type.owner = overrides.owner;
	type.structName = overrides.structName;
	return type;
}

function parseSourceLocation(span: any): SourceLocation {
	if (!span || !Array.isArray(span.begin) || !Array.isArray(span.end)) {
		return ZERO_LOCATION;
	}

	const line = typeof span.begin[0] === 'number' ? span.begin[0] : 0;
	const column = typeof span.begin[1] === 'number' ? span.begin[1] : 0;
	const endColumn = typeof span.end[1] === 'number' ? span.end[1] : column;
	const length = Math.max(0, endColumn - column);

	return { line, column, length };
}

function normalizePathName(pathName: string): string {
	return pathName.split('::').pop() ?? pathName;
}

function parsePathName(value: any): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	if (typeof value.path === 'string') {
		return normalizePathName(value.path);
	}

	if (value.resolved_path) {
		return parsePathName(value.resolved_path);
	}

	if (value.type) {
		return parsePathName(value.type);
	}

	if (typeof value.generic === 'string') {
		return value.generic;
	}

	return null;
}

function parseFullPathName(value: any, paths: Record<string, any>): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	if (typeof value.path === 'string' && typeof value.id === 'number') {
		const pathEntry = paths[String(value.id)];
		if (pathEntry?.path && Array.isArray(pathEntry.path)) {
			return pathEntry.path.join('::');
		}
		return value.path;
	}

	if (value.resolved_path) {
		return parseFullPathName(value.resolved_path, paths);
	}

	if (value.type) {
		return parseFullPathName(value.type, paths);
	}

	if (typeof value.generic === 'string') {
		return value.generic;
	}

	return null;
}

function parsePrimitiveType(name: string): Type {
	if (name === 'str') {
		return createType({ valType: ValType.STRING, primitive: false });
	}

	if (
		name === 'bool' ||
		/^u?\d+$/.test(name) ||
		name === 'usize' ||
		name === 'isize' ||
		name === 'f32' ||
		name === 'f64' ||
		name === 'char'
	) {
		return createType({ valType: ValType.INT, primitive: true });
	}

	if (name === '()') {
		return createType({ valType: ValType.VOID, primitive: false });
	}

	return createType({ valType: ValType.UNKNOWN, primitive: false });
}

function parseTypeDesc(typeDesc: any): Type {
	if (!typeDesc || typeof typeDesc !== 'object') {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('type' in typeDesc && typeof typeDesc.type === 'object') {
		return parseTypeDesc(typeDesc.type);
	}

	if ('primitive' in typeDesc && typeof typeDesc.primitive === 'string') {
		return parsePrimitiveType(typeDesc.primitive);
	}

	if ('generic' in typeDesc && typeof typeDesc.generic === 'string') {
		if (typeDesc.generic === 'Self') {
			return createType({ valType: ValType.STRUCT, structName: 'Self' });
		}
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('borrowed_ref' in typeDesc && typeof typeDesc.borrowed_ref === 'object') {
		const inner = parseTypeDesc(typeDesc.borrowed_ref.type);
		return createType({
			valType: ValType.REFERENCE,
			mutableReference: Boolean(typeDesc.borrowed_ref.is_mutable),
			elementType: inner.valType,
			structName: inner.structName
		});
	}

	if ('slice' in typeDesc && typeof typeDesc.slice === 'object') {
		const element = parseTypeDesc(typeDesc.slice);
		return createType({
			valType: ValType.VECTOR,
			elementType: element.valType,
			structName: element.structName
		});
	}

	if ('array' in typeDesc && typeof typeDesc.array === 'object') {
		const element = parseTypeDesc(typeDesc.array.type);
		return createType({
			valType: ValType.VECTOR,
			elementType: element.valType,
			structName: element.structName
		});
	}

	if ('resolved_path' in typeDesc && typeof typeDesc.resolved_path === 'object') {
		const resolved = typeDesc.resolved_path;
		const pathName = normalizePathName(resolved.path ?? '');
		const angleArgs = resolved.args?.angle_bracketed?.args ?? [];

		if (pathName === 'Vec') {
			const inner = angleArgs.length > 0 ? parseTypeDesc(angleArgs[0].type ?? angleArgs[0]) : createType({ valType: ValType.UNKNOWN });
			return createType({
				valType: ValType.VECTOR,
				elementType: inner.valType,
				structName: inner.structName
			});
		}

		if (pathName === 'str') {
			return createType({ valType: ValType.STRING, primitive: false });
		}

		if (pathName === 'Option' || pathName === 'Result' || pathName === 'Box' || pathName === 'VecDeque' || pathName === 'HashMap' || pathName === 'HashSet') {
			return createType({ valType: ValType.STRUCT, structName: pathName });
		}

		return createType({ valType: ValType.STRUCT, structName: pathName });
	}

	if ('qualified_path' in typeDesc && typeof typeDesc.qualified_path === 'object') {
		return parseTypeDesc(typeDesc.qualified_path);
	}

	if ('raw_pointer' in typeDesc) {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('tuple' in typeDesc) {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('lifetime' in typeDesc && 'type' in typeDesc) {
		return parseTypeDesc(typeDesc.type);
	}

	return createType({ valType: ValType.UNKNOWN });
}

function parseParam([name, typeDesc]: [string, any]): Param {
	return {
		name,
		location: ZERO_LOCATION,
		type: parseTypeDesc(typeDesc)
	};
}

function parseFunctionEntry(entry: any, struct: SharedStruct | null, functions: SharedFunction[]) {
	const fn = entry?.inner?.function;
	if (!fn) {
		return null;
	}
	console.log(fn)
	console.log(entry)

	const parsed: SharedFunction = {
		name: typeof entry.name === 'string' ? entry.name : 'unknown',
		location: parseSourceLocation(entry.span),
		type: fn.sig?.output ? parseTypeDesc(fn.sig.output) : createType({ valType: ValType.VOID }),
		params: Array.isArray(fn.sig?.inputs) ? fn.sig.inputs.map(parseParam) : []
	};

	if (struct) {
		if (parsed.params.length > 0 && parsed.params[0].type.valType === ValType.STRUCT && parsed.params[0].type.structName === 'Self') {
			struct.methods.push(parsed);
			console.log(`Function ${parsed.name} is a method of struct ${struct.name}`);
			parsed.structName = struct.name;
			return
		}

		parsed.structName = struct.name;
	}

	functions.push(parsed);
}

function parseStructFields(structEntry: any, index: Record<string, any>): Param[] {
	if (!structEntry || typeof structEntry !== 'object') {
		return [];
	}

	if (structEntry.plain && Array.isArray(structEntry.plain.fields)) {
		const parsedFields: Array<Param | null> = structEntry.plain.fields
			.map((fieldId: any, fieldIndex: number): Param | null => {
				const field = index[String(fieldId)];
				if (!field) {
					return null;
				}

				return {
					name: typeof field.name === 'string' ? field.name : `_${fieldIndex}`,
					location: parseSourceLocation(field.span),
					type: parseTypeDesc(field.inner?.struct_field ?? field.inner?.type)
				};
			});

		return parsedFields.filter((field): field is Param => field !== null);
	}

	if (structEntry.tuple && Array.isArray(structEntry.tuple)) {
		return structEntry.tuple.map((typeDesc: any, index: number) => ({
			name: `_${index}`,
			location: ZERO_LOCATION,
			type: parseTypeDesc(typeDesc)
		}));
	}

	return [];
}

function buildMethodOwnerMap(index: Record<string, any>, paths: Record<string, any>): Record<string, string> {
	const map: Record<string, string> = {};

	for (const [id, entry] of Object.entries(index)) {
		console.log
		const impl = entry?.inner?.impl;
		if (!impl || !Array.isArray(impl.items)) {
			continue;
		}

		const ownerName = parseFullPathName(impl.for, paths) || parsePathName(impl.for) || 'unknown';
		for (const item of impl.items) {
			map[String(item)] = ownerName;
		}
	}

	return map;
}

function parseStructEntry(entry: any, index: Record<string, any>): SharedStruct | null {
	const structEntry = entry?.inner?.struct;
	if (!structEntry) {
		return null;
	}

	const name = typeof entry.name === 'string' ? entry.name : 'unknown';

	const methods: SharedFunction[] = [];


	return {
		name,
		location: parseSourceLocation(entry.span),
		fields: parseStructFields(structEntry.kind, index),
		methods,
		iterable: undefined,
		index: undefined,
		impls: structEntry.impls
	};
}

function parseImplEntry(entry: any, index: Record<string, any>, structs: SharedStruct[], functions: SharedFunction[]) {
	const implEntry = entry?.inner?.impl;
	if (!implEntry) {
		return null;
	}


	if (!implEntry.for?.resolved_path?.path) {
		return
	}
	
	if (parsePathName(implEntry.for) !== 'HashSet') {
		return
	}
	console.log("hey hey")
	console.log(implEntry)

	console.log(parsePathName(implEntry.for))
	
	structs.filter(s => s.name === parsePathName(implEntry.for)).forEach(s => {
		if (s.impls) {
			implEntry.items.forEach((itemId: any) => {
				const itemEntry = index[String(itemId)];
				parseFunctionEntry(itemEntry, s, functions)
			});
	
		}
	});
	
}

export function parseStdJson(stdJson: any): StdParseResult {
	const index = stdJson?.index ?? {};
	const paths = stdJson?.paths ?? {};
	const methodOwnerByItem = buildMethodOwnerMap(index, paths);
	const allFunctions: Record<string, SharedFunction> = {};

	// for (const [id, entry] of Object.entries(index)) {
	// 	const func = parseFunctionEntry(entry, methodOwnerByItem, id);
	// 	if (func) {
	// 		allFunctions[id] = func;
	// 	}
	// }

	const structs: SharedStruct[] = [];
	const functions: SharedFunction[] = [];
	for (const [id, entry] of Object.entries(index)) {
		const parsedStruct = parseStructEntry(entry, index);
		if (parsedStruct) {
			structs.push(parsedStruct);
		}
	}

	for (const [id, entry] of Object.entries(index)) {
		const parsedImpl = parseImplEntry(entry, index, structs, functions);

	}

	return {
		functions: Object.values(allFunctions),
		structs
	};
}

export async function parseStdJsonFile(): Promise<StdParseResult> {
	const raw = await fs.readFile(stdJsonPath, 'utf8');
	const json = JSON.parse(raw);
	return parseStdJson(json);
}
