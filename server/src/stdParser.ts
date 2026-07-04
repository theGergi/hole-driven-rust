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
const coreJsonPath  = path.resolve(__dirname, '..', 'src', 'assets', 'core.json');

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

		if (pathName === 'str') {
			return createType({ valType: ValType.STRUCT, structName: 'str', primitive: false });
		}

		const inner = angleArgs.length > 0 ? parseTypeDesc(angleArgs[0].type ?? angleArgs[0]) : undefined;
		return createType({
			valType: ValType.STRUCT,
			structName: pathName,
			elementType: inner,
		});
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

// trait name -> (method name -> raw index item entry for that default-body method).
// Concrete impls only restate items they override, so a type implementing e.g. Iterator
// without overriding `collect`/`map`/`filter` would otherwise never expose them.
function buildTraitDefaultMethods(index: Record<string, any>): Map<string, Map<string, any>> {
	const result = new Map<string, Map<string, any>>();
	for (const entry of Object.values(index)) {
		const trait = (entry as any)?.inner?.trait;
		if (!trait || !Array.isArray(trait.items)) continue;
		const traitName = typeof (entry as any).name === 'string' ? (entry as any).name : null;
		if (!traitName) continue;

		const methodMap = result.get(traitName) ?? new Map<string, any>();
		for (const itemId of trait.items) {
			const itemEntry = index[String(itemId)];
			if (itemEntry?.inner?.function?.has_body === true && typeof itemEntry.name === 'string') {
				methodMap.set(itemEntry.name, itemEntry);
			}
		}
		if (methodMap.size > 0) result.set(traitName, methodMap);
	}
	return result;
}

// A trait implemented by a struct in one crate (e.g. alloc) may be fully defined with
// default method bodies only in another (e.g. core), so this is built across all three
// std/alloc/core files before any of them are parsed.
function mergeTraitDefaultMethods(maps: Map<string, Map<string, any>>[]): Map<string, Map<string, any>> {
	const merged = new Map<string, Map<string, any>>();
	for (const map of maps) {
		for (const [traitName, methods] of map) {
			const target = merged.get(traitName) ?? new Map<string, any>();
			for (const [methodName, itemEntry] of methods) {
				if (!target.has(methodName)) target.set(methodName, itemEntry);
			}
			merged.set(traitName, target);
		}
	}
	return merged;
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

function parseImplEntry(
	entry: any,
	index: Record<string, any>,
	structs: SharedStruct[],
	functions: SharedFunction[],
	traitDefaultMethods: Map<string, Map<string, any>>
) {
	const implEntry = entry?.inner?.impl;
	if (!implEntry || !Array.isArray(implEntry.items)) {
		return;
	}

	const traitName = implEntry.trait != null ? normalizePathName(implEntry.trait?.path ?? '') : null;

	// Applies this impl's own (overridden) items to a struct, then fills in any of the
	// trait's default-body methods (e.g. Iterator::collect/map/filter) that this impl
	// didn't override. The guard only applies to defaults — an override always wins.
	const applyTo = (s: SharedStruct) => {
		implEntry.items.forEach((itemId: any) => {
			const itemEntry = index[String(itemId)];
			parseFunctionEntry(itemEntry, s, functions);
		});

		if (traitName) {
			traitDefaultMethods.get(traitName)?.forEach((itemEntry, methodName) => {
				if (!s.methods.some(m => m.name === methodName)) {
					parseFunctionEntry(itemEntry, s, functions);
				}
			});
		}
	};

	const primitiveFor = implEntry.for?.primitive;
	if (primitiveFor === 'str') {
		structs.filter(s => s.name === 'str').forEach(applyTo);
		return;
	}

	if (implEntry.for?.slice && typeof implEntry.for.slice.generic === 'string') {
		structs.filter(s => s.name === 'slice').forEach(applyTo);
		return;
	}

	if (!implEntry.for?.resolved_path?.path) {
		return;
	}

	const ownerName = parsePathName(implEntry.for);
	if (!ownerName) {
		return;
	}

	structs.filter(s => s.name === ownerName && s.impls).forEach(applyTo);
}

export function parseStdJson(
	stdJson: any,
	externalPreludeNames?: Set<string>,
	traitDefaultMethods: Map<string, Map<string, any>> = new Map()
): StdParseResult {
	const index = stdJson?.index ?? {};
	const paths = stdJson?.paths ?? {};

	const structs: SharedStruct[] = [];
	const functions: SharedFunction[] = [];

	const preludeNames = externalPreludeNames ?? buildPreludeNames(index, paths);

	for (const [id, entry] of Object.entries(index)) {
		const parsedStruct = parseStructEntry(entry, index, id, paths, preludeNames);
		if (parsedStruct) {
			structs.push(parsedStruct);
			continue;
		}

		const primitive = (entry as any)?.inner?.primitive;
		if (primitive && primitive.name === 'slice') {
			structs.push({
				name: 'slice',
				location: ZERO_LOCATION,
				fields: [],
				methods: [],
				path: ['slice'],
				iterable: true,
				index: true,
				impls: Array.isArray(primitive.impls) ? primitive.impls : [],
				prelude: undefined,
			});
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
		parseImplEntry(entry, index, structs, functions, traitDefaultMethods);
	}

	return {
		functions,
		structs
	};
}

function mergeStructsByName(structLists: SharedStruct[][]): SharedStruct[] {
	const byName = new Map<string, SharedStruct>();

	for (const list of structLists) {
		for (const s of list) {
			const existing = byName.get(s.name);
			if (!existing) {
				byName.set(s.name, { ...s, methods: [...s.methods] });
				continue;
			}

			const existingMethodNames = new Set(existing.methods.map(m => m.name));
			for (const method of s.methods) {
				if (!existingMethodNames.has(method.name)) {
					existing.methods.push(method);
					existingMethodNames.add(method.name);
				}
			}
			if (existing.fields.length === 0 && s.fields.length > 0) {
				existing.fields = s.fields;
			}
			existing.iterable = existing.iterable ?? s.iterable;
			existing.index = existing.index ?? s.index;
			existing.prelude = existing.prelude ?? s.prelude;
		}
	}

	return [...byName.values()];
}

let cachedStdParseResult: StdParseResult | null = null;

export function parseStdJsonFile(): StdParseResult {
	if (cachedStdParseResult) {
		return cachedStdParseResult;
	}

	const stdRaw   = JSON.parse(fs.readFileSync(stdJsonPath,   'utf8'));
	const allocRaw = JSON.parse(fs.readFileSync(allocJsonPath, 'utf8'));
	const coreRaw  = JSON.parse(fs.readFileSync(coreJsonPath,  'utf8'));

	// Prelude names are defined in std.json; share them with alloc/core so Vec/String/Box get marked
	const preludeNames = buildPreludeNames(stdRaw?.index ?? {}, stdRaw?.paths ?? {});

	// A trait implemented by a struct in one crate may only have its full definition
	// (with default method bodies) in another crate's index, so this is built across
	// all three files up front and shared by every parseStdJson call below.
	const traitDefaultMethods = mergeTraitDefaultMethods([
		buildTraitDefaultMethods(stdRaw?.index ?? {}),
		buildTraitDefaultMethods(allocRaw?.index ?? {}),
		buildTraitDefaultMethods(coreRaw?.index ?? {}),
	]);

	const std   = parseStdJson(stdRaw,   preludeNames, traitDefaultMethods);
	const alloc = parseStdJson(allocRaw, preludeNames, traitDefaultMethods);
	const core  = parseStdJson(coreRaw,  preludeNames, traitDefaultMethods);

	const structs = mergeStructsByName([std.structs, alloc.structs, core.structs]);
	const functions = [...std.functions, ...alloc.functions, ...core.functions];

	const sliceStruct = structs.find(s => s.name === 'slice');
	const vecStruct = structs.find(s => s.name === 'Vec');
	if (sliceStruct && vecStruct) {
		const vecMethodNames = new Set(vecStruct.methods.map(m => m.name));
		for (const method of sliceStruct.methods) {
			if (!vecMethodNames.has(method.name)) {
				vecStruct.methods.push({ ...method, structName: 'Vec' });
				vecMethodNames.add(method.name);
			}
		}
	}

	cachedStdParseResult = { functions, structs };
	return cachedStdParseResult;
}



/// "name": "HashMap",