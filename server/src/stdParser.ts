import fs from 'fs';
import path from 'path';
import {
	Borrow,
	Param,
	SourceLocation,
	SharedStruct,
	Type,
	ValType,
	Function as SharedFunction
} from '../../shared/out/types.js';


const stdJsonPath   = path.resolve(__dirname, '..', 'src', 'assets', 'std.json');
const allocJsonPath = path.resolve(__dirname, '..', 'src', 'assets', 'alloc.json');

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


function parsePrimitiveType(name: string): Type {
	if (name === 'str') {
		return createType({ valType: ValType.STRUCT, structName: 'str', primitive: false });
	}

	if (name === 'f32' || name === 'f64') {
		return createType({ valType: ValType.FLOAT, primitive: true });
	}

	if (
		name === 'bool' ||
		/^u?\d+$/.test(name) ||
		name === 'usize' ||
		name === 'isize' ||
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
			elementType: inner,
			structName: inner.structName
		});
	}

	if ('slice' in typeDesc && typeof typeDesc.slice === 'object') {
		const element = parseTypeDesc(typeDesc.slice);
		return createType({
			valType: ValType.VECTOR,
			elementType: element,
			structName: element.structName
		});
	}

	if ('array' in typeDesc && typeof typeDesc.array === 'object') {
		const element = parseTypeDesc(typeDesc.array.type);
		return createType({
			valType: ValType.VECTOR,
			elementType: element,
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
				valType: ValType.STRUCT,
				structName: 'Vec',
				elementType: inner,
			});
		}

		if (pathName === 'str') {
			return createType({ valType: ValType.STRUCT, structName: 'str', primitive: false });
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

function isSelfParam(param: Param): boolean {
	if (param.name === 'self') return true;
	const t = param.type;
	if (t.valType === ValType.STRUCT && t.structName === 'Self') return true;
	if (t.valType === ValType.REFERENCE && t.structName === 'Self') return true;
	return false;
}

function parseFunctionEntry(entry: any, struct: SharedStruct | null, functions: SharedFunction[]) {
	const fn = entry?.inner?.function;
	if (!fn) {
		return null;
	}

	const parsed: SharedFunction = {
		name: typeof entry.name === 'string' ? entry.name : 'unknown',
		location: parseSourceLocation(entry.span),
		type: fn.sig?.output ? parseTypeDesc(fn.sig.output) : createType({ valType: ValType.VOID }),
		params: Array.isArray(fn.sig?.inputs) ? fn.sig.inputs.map(parseParam) : []
	};

	if (struct) {
		if (parsed.params.length > 0 && isSelfParam(parsed.params[0])) {
			parsed.structName = struct.name;
			struct.methods.push(parsed);
			return;
		}

		parsed.structName = struct.name;
		if (parsed.type?.valType === ValType.STRUCT && parsed.type.structName === 'Self') {
			parsed.type.structName = struct.name;
		}
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


function buildPreludeNames(index: Record<string, any>, paths: Record<string, any>): Set<string> {
	const names = new Set<string>();

	// Find std::prelude module by its path
	const preludeId = Object.keys(paths).find(id => {
		const p = paths[id];
		return Array.isArray(p?.path) && p.path.join('::') === 'std::prelude';
	});
	if (!preludeId) return names;

	const preludeEntry = index[preludeId];
	const submoduleIds: number[] = preludeEntry?.inner?.module?.items ?? [];

	for (const subId of submoduleIds) {
		const subEntry = index[String(subId)];
		const itemIds: number[] = subEntry?.inner?.module?.items ?? [];
		for (const itemId of itemIds) {
			const itemEntry = index[String(itemId)];
			const source: string | undefined = itemEntry?.inner?.use?.source;
			if (typeof source === 'string') {
				const leaf = source.split('::').pop();
				if (leaf) names.add(leaf);
			}
		}
	}

	return names;
}

function parseStructEntry(entry: any, index: Record<string, any>, id: string, paths: Record<string, any>, preludeNames: Set<string>): SharedStruct | null {
	const structEntry = entry?.inner?.struct;
	if (!structEntry) {
		return null;
	}

	const name = typeof entry.name === 'string' ? entry.name : 'unknown';
	const pathEntry = paths[id];
	const path: string[] | undefined = Array.isArray(pathEntry?.path) ? pathEntry.path : undefined;

	return {
		name,
		location: parseSourceLocation(entry.span),
		fields: parseStructFields(structEntry.kind, index),
		methods: [],
		path,
		iterable: undefined,
		index: undefined,
		impls: structEntry.impls,
		prelude: preludeNames.has(name) ? true : undefined
	};
}

function parseImplEntry(entry: any, index: Record<string, any>, structs: SharedStruct[], functions: SharedFunction[]) {
	const implEntry = entry?.inner?.impl;
	if (!implEntry || !Array.isArray(implEntry.items)) {
		return;
	}

	// Skip trait impls EXCEPT From — From impls provide constructors (e.g. String::from, Vec::from)
	if (implEntry.trait != null) {
		const traitName = normalizePathName(implEntry.trait?.path ?? '');
		if (traitName !== 'From') {
			return;
		}
	}

	const primitiveFor = implEntry.for?.primitive;
	if (primitiveFor === 'str') {
		const strStructs = structs.filter(s => s.name === 'str');
		strStructs.forEach(s => {
			implEntry.items.forEach((itemId: any) => {
				const itemEntry = index[String(itemId)];
				parseFunctionEntry(itemEntry, s, functions);
			});
		});
		return;
	}

	if (!implEntry.for?.resolved_path?.path) {
		return;
	}

	const ownerName = parsePathName(implEntry.for);
	if (!ownerName) {
		return;
	}

	const matchingStructs = structs.filter(s => s.name === ownerName && s.impls);
	matchingStructs.forEach(s => {
		implEntry.items.forEach((itemId: any) => {
			const itemEntry = index[String(itemId)];
			parseFunctionEntry(itemEntry, s, functions);
		});
	});
}

export function parseStdJson(stdJson: any, externalPreludeNames?: Set<string>): StdParseResult {
	const index = stdJson?.index ?? {};
	const paths = stdJson?.paths ?? {};

	const structs: SharedStruct[] = [];
	const functions: SharedFunction[] = [];

	const preludeNames = externalPreludeNames ?? buildPreludeNames(index, paths);

	for (const [id, entry] of Object.entries(index)) {
		const parsedStruct = parseStructEntry(entry, index, id, paths, preludeNames);
		if (parsedStruct) {
			structs.push(parsedStruct);
		}
	}

	structs.push({
		name: 'str',
		location: { line: 0, column: 0, length: 0 },
		fields: [],
		methods: [],
		path: ['str'],
		iterable: true,
		index: true,
		impls: undefined,
		prelude: true,
	});

	// Build the set of IDs that belong to impl blocks so we don't process them twice
	const implItemIds = new Set<string>();
	for (const [, entry] of Object.entries(index)) {
		const impl = (entry as any)?.inner?.impl;
		if (impl && Array.isArray(impl.items)) {
			impl.items.forEach((itemId: any) => implItemIds.add(String(itemId)));
		}
	}

	for (const [id, entry] of Object.entries(index)) {
		// Only scan free functions (those not owned by an impl block)
		if (!implItemIds.has(id)) {
			parseFunctionEntry(entry as any, null, functions);
		}
		parseImplEntry(entry, index, structs, functions);
	}

	return {
		functions,
		structs
	};
}

export function parseStdJsonFile(): StdParseResult {
	const stdRaw   = JSON.parse(fs.readFileSync(stdJsonPath,   'utf8'));
	const allocRaw = JSON.parse(fs.readFileSync(allocJsonPath, 'utf8'));

	// Prelude names are defined in std.json; share them with alloc so Vec/String/Box get marked
	const preludeNames = buildPreludeNames(stdRaw?.index ?? {}, stdRaw?.paths ?? {});

	const std   = parseStdJson(stdRaw,   preludeNames);
	const alloc = parseStdJson(allocRaw, preludeNames);

	return {
		functions: [...std.functions, ...alloc.functions],
		structs:   [...std.structs,   ...alloc.structs],
	};
}



/// "name": "HashMap",