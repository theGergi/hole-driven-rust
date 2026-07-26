import fs from 'fs';
import path from 'path';
import {
	Borrow,
	Param,
	SourceLocation,
	SharedStruct,
	Trait,
	Type,
	ValType,
	Function as SharedFunction,
	BUILTIN_TYPE_NAMES,
	isPrimitiveTypeName
} from '../../shared/out/types.js';


const stdJsonPath   = path.resolve(__dirname, '..', 'src', 'assets', 'std.json');
const allocJsonPath = path.resolve(__dirname, '..', 'src', 'assets', 'alloc.json');
const coreJsonPath  = path.resolve(__dirname, '..', 'src', 'assets', 'core.json');

export interface StdParseResult {
	functions: SharedFunction[];
	structs: SharedStruct[];
	traits: Trait[];
}

interface InternalParseStdJsonResult extends StdParseResult {
	blanketImpls: BlanketImpl[];
}

const ZERO_LOCATION: SourceLocation = { line: 0, column: 0, length: 0 };

function createType(overrides: Partial<Type>): Type {
	const type = new Type();
	type.valType = overrides.valType ?? ValType.UNKNOWN;
	type.elementType = overrides.elementType;
	type.primitive = overrides.primitive ?? isPrimitiveTypeName(overrides.structName);
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
	if (name === '()') {
		return createType({ valType: ValType.VOID });
	}

	return createType({ valType: ValType.STRUCT, structName: name });
}

// Maps a function's own generic type parameter names (e.g. "T") to the name of the first
// trait bounding them (e.g. "Ord" for `fn max<T: Ord>(...)`), so an unresolved generic can be
// typed as that trait rather than falling back to UNKNOWN.
function buildGenericBounds(generics: any): Record<string, string> {
	const bounds: Record<string, string> = {};
	const params = generics?.params;
	if (!Array.isArray(params)) return bounds;

	for (const param of params) {
		const name = param?.name;
		const traitBounds = param?.kind?.type?.bounds;
		if (typeof name !== 'string' || !Array.isArray(traitBounds)) continue;

		for (const bound of traitBounds) {
			const traitPath = bound?.trait_bound?.trait?.path;
			if (typeof traitPath === 'string') {
				bounds[name] = normalizePathName(traitPath);
				break;
			}
		}
	}

	return bounds;
}
function getRequiredBoundTraits(generics: any, paramName: string): string[] {
	const params = generics?.params;
	if (!Array.isArray(params)) return [];

	const param = params.find((p: any) => p?.name === paramName);
	const traitBounds = param?.kind?.type?.bounds;
	if (!Array.isArray(traitBounds)) return [];

	const names: string[] = [];
	for (const bound of traitBounds) {
		const traitBound = bound?.trait_bound;
		if (!traitBound || traitBound.modifier === 'maybe') continue;
		const traitPath = traitBound.trait?.path;
		if (typeof traitPath === 'string') names.push(normalizePathName(traitPath));
	}
	return names;
}

function parseTypeDesc(typeDesc: any, genericBounds?: Record<string, string>): Type {
	if (!typeDesc || typeof typeDesc !== 'object') {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('type' in typeDesc && typeof typeDesc.type === 'object') {
		return parseTypeDesc(typeDesc.type, genericBounds);
	}

	if ('primitive' in typeDesc && typeof typeDesc.primitive === 'string') {
		return parsePrimitiveType(typeDesc.primitive);
	}

	if ('generic' in typeDesc && typeof typeDesc.generic === 'string') {
		if (typeDesc.generic === 'Self') {
			return createType({ valType: ValType.STRUCT, structName: 'Self' });
		}
		const boundTrait = genericBounds?.[typeDesc.generic];
		if (boundTrait) {
			return createType({ valType: ValType.TRAIT, structName: boundTrait });
		}
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('borrowed_ref' in typeDesc && typeof typeDesc.borrowed_ref === 'object') {
		const inner = parseTypeDesc(typeDesc.borrowed_ref.type, genericBounds);
		return createType({
			valType: ValType.REFERENCE,
			mutableReference: Boolean(typeDesc.borrowed_ref.is_mutable),
			elementType: inner,
			structName: inner.structName
		});
	}

	if ('slice' in typeDesc && typeof typeDesc.slice === 'object') {
		const element = parseTypeDesc(typeDesc.slice, genericBounds);
		return createType({
			valType: ValType.VECTOR,
			elementType: element,
			structName: element.structName
		});
	}

	if ('array' in typeDesc && typeof typeDesc.array === 'object') {
		const element = parseTypeDesc(typeDesc.array.type, genericBounds);
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

		const inner = angleArgs.length > 0 ? parseTypeDesc(angleArgs[0].type ?? angleArgs[0], genericBounds) : undefined;
		return createType({
			valType: ValType.STRUCT,
			structName: pathName,
			elementType: inner,
		});
	}

	if ('qualified_path' in typeDesc && typeof typeDesc.qualified_path === 'object') {
		return parseTypeDesc(typeDesc.qualified_path, genericBounds);
	}

	if ('raw_pointer' in typeDesc) {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('tuple' in typeDesc) {
		return createType({ valType: ValType.UNKNOWN });
	}

	if ('lifetime' in typeDesc && 'type' in typeDesc) {
		return parseTypeDesc(typeDesc.type, genericBounds);
	}

	return createType({ valType: ValType.UNKNOWN });
}

function parseParam([name, typeDesc]: [string, any], genericBounds?: Record<string, string>): Param {
	return {
		name,
		location: ZERO_LOCATION,
		type: parseTypeDesc(typeDesc, genericBounds)
	};
}

function isSelfParam(param: Param): boolean {
	if (param.name === 'self') return true;
	const t = param.type;
	if (t.valType === ValType.STRUCT && t.structName === 'Self') return true;
	if (t.valType === ValType.REFERENCE && t.structName === 'Self') return true;
	return false;
}

function buildFunctionCore(entry: any): SharedFunction | null {
	const fn = entry?.inner?.function;
	if (!fn) {
		return null;
	}

	const genericBounds = buildGenericBounds(fn.generics);

	return {
		name: typeof entry.name === 'string' ? entry.name : 'unknown',
		location: parseSourceLocation(entry.span),
		type: fn.sig?.output ? parseTypeDesc(fn.sig.output, genericBounds) : createType({ valType: ValType.VOID }),
		params: Array.isArray(fn.sig?.inputs) ? fn.sig.inputs.map((p: [string, any]) => parseParam(p, genericBounds)) : []
	};
}

function parseFunctionEntry(
	entry: any,
	structName: string | null,
	methodsTarget: SharedFunction[] | null,
	functions: SharedFunction[],
	pathInfo?: { id: string; paths: Record<string, any> },
	preludeNames?: Set<string>
) {
	const parsed = buildFunctionCore(entry);
	if (!parsed) {
		return null;
	}

	if (structName) {
		if (parsed.params.length > 0 && isSelfParam(parsed.params[0])) {
			parsed.structName = structName;
			methodsTarget?.push(parsed);
			return;
		}

		parsed.structName = structName;
		if (parsed.type?.valType === ValType.STRUCT && parsed.type.structName === 'Self') {
			parsed.type.structName = structName;
		}
	} else if (pathInfo) {
		const pathEntry = pathInfo.paths[pathInfo.id];
		if (Array.isArray(pathEntry?.path)) {
			parsed.path = pathEntry.path;
		}
		if (preludeNames?.has(parsed.name)) {
			parsed.prelude = true;
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

interface TraitDefinition {
	location: SourceLocation;
	path: string[];
	defaultMethods: Map<string, any>;
}

interface BlanketImpl {
	traitName: string;
	boundTraits: string[];
	location: SourceLocation;
	path: string[];
	methods: SharedFunction[];
}

function buildTraitDefinitions(index: Record<string, any>, paths: Record<string, any>): Map<string, TraitDefinition> {
	const result = new Map<string, TraitDefinition>();
	for (const [id, entry] of Object.entries(index)) {
		const trait = (entry as any)?.inner?.trait;
		if (!trait || !Array.isArray(trait.items)) continue;
		const traitName = typeof (entry as any).name === 'string' ? (entry as any).name : null;
		if (!traitName) continue;

		const defaultMethods = new Map<string, any>();
		for (const itemId of trait.items) {
			const itemEntry = index[String(itemId)];
			if (itemEntry?.inner?.function?.has_body === true && typeof itemEntry.name === 'string') {
				defaultMethods.set(itemEntry.name, itemEntry);
			}
		}

		const pathEntry = paths[id];
		const path: string[] = Array.isArray(pathEntry?.path) ? pathEntry.path : [];

		result.set(traitName, {
			location: parseSourceLocation((entry as any).span),
			path,
			defaultMethods
		});
	}
	return result;
}

// A trait implemented by a struct in one crate (e.g. alloc) may be fully defined with
// default method bodies only in another (e.g. core), so this is built across all three
// std/alloc/core files before any of them are parsed.
function mergeTraitDefinitions(defsList: Map<string, TraitDefinition>[]): Map<string, TraitDefinition> {
	const merged = new Map<string, TraitDefinition>();
	for (const defs of defsList) {
		for (const [traitName, def] of defs) {
			const target = merged.get(traitName);
			if (!target) {
				merged.set(traitName, { location: def.location, path: def.path, defaultMethods: new Map(def.defaultMethods) });
				continue;
			}
			for (const [methodName, itemEntry] of def.defaultMethods) {
				if (!target.defaultMethods.has(methodName)) target.defaultMethods.set(methodName, itemEntry);
			}
			if (target.path.length === 0 && def.path.length > 0) target.path = def.path;
		}
	}
	return merged;
}

function buildStdTraits(index: Record<string, any>, paths: Record<string, any>, preludeNames: Set<string>): Trait[] {
	const traitDefs = buildTraitDefinitions(index, paths);
	const traits: Trait[] = [];

	for (const [name, def] of traitDefs) {
		const methods: SharedFunction[] = [];
		def.defaultMethods.forEach((itemEntry) => {
			const method = buildFunctionCore(itemEntry);
			if (method) methods.push(method);
		});

		traits.push({
			name,
			location: def.location,
			path: def.path,
			methods,
			prelude: preludeNames.has(name) ? true : undefined
		});
	}

	return traits;
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
		impls: structEntry.impls,
		prelude: preludeNames.has(name) ? true : undefined,
		traits: []
	};
}

function parseImplEntry(
	entry: any,
	index: Record<string, any>,
	structs: SharedStruct[],
	functions: SharedFunction[],
	traitDefinitions: Map<string, TraitDefinition>,
	blanketImpls: BlanketImpl[]
) {
	const implEntry = entry?.inner?.impl;
	if (!implEntry || !Array.isArray(implEntry.items)) {
		return;
	}

	const traitName = implEntry.trait != null ? normalizePathName(implEntry.trait?.path ?? '') : null;

	const forGenericName = implEntry.for?.generic;
	if (traitName && typeof forGenericName === 'string' &&
		Array.isArray(implEntry.generics?.params) &&
		implEntry.generics.params.some((p: any) => p?.name === forGenericName)) {

		const boundTraits = getRequiredBoundTraits(implEntry.generics, forGenericName);
		if (boundTraits.length > 0) {
			const traitDef = traitDefinitions.get(traitName);
			const methods: SharedFunction[] = [];
			implEntry.items.forEach((itemId: any) => {
				const method = buildFunctionCore(index[String(itemId)]);
				if (method) methods.push(method);
			});
			traitDef?.defaultMethods.forEach((itemEntry, methodName) => {
				if (!methods.some(m => m.name === methodName)) {
					const method = buildFunctionCore(itemEntry);
					if (method) methods.push(method);
				}
			});

			blanketImpls.push({
				traitName,
				boundTraits,
				location: traitDef?.location ?? ZERO_LOCATION,
				path: traitDef?.path ?? [],
				methods
			});
		}
		return;
	}

	const applyTo = (s: SharedStruct) => {
		if (!traitName) {
			implEntry.items.forEach((itemId: any) => {
				const itemEntry = index[String(itemId)];
				parseFunctionEntry(itemEntry, s.name, s.methods, functions);
			});
			return;
		}

		const traitDef = traitDefinitions.get(traitName);
		const trait: Trait = {
			name: traitName,
			location: traitDef?.location ?? ZERO_LOCATION,
			path: traitDef?.path ?? [],
			methods: []
		};

		implEntry.items.forEach((itemId: any) => {
			const itemEntry = index[String(itemId)];
			parseFunctionEntry(itemEntry, s.name, trait.methods, functions);
		});

		traitDef?.defaultMethods.forEach((itemEntry, methodName) => {
			if (!trait.methods.some(m => m.name === methodName)) {
				parseFunctionEntry(itemEntry, s.name, trait.methods, functions);
			}
		});

		s.traits.push(trait);
	};

	// `impl f32 { ... }`, `impl str { ... }`, `impl Ord for u8 { ... }`, ... — attached to the
	// struct registered for that primitive by registerPrimitiveStructs.
	const primitiveFor = implEntry.for?.primitive;
	if (typeof primitiveFor === 'string') {
		structs.filter(s => s.name === primitiveFor).forEach(applyTo);
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

// Primitives are dealt with as normal structs
function registerPrimitiveStructs(index: Record<string, any>, structs: SharedStruct[]): void {
	const implsByName = new Map<string, any[]>();

	for (const entry of Object.values(index)) {
		const primitive = (entry as any)?.inner?.primitive;
		if (typeof primitive?.name === 'string') {
			implsByName.set(primitive.name, Array.isArray(primitive.impls) ? primitive.impls : []);
			continue;
		}

		const implTarget = (entry as any)?.inner?.impl?.for?.primitive;
		if (typeof implTarget === 'string' && !implsByName.has(implTarget)) {
			implsByName.set(implTarget, []);
		}
	}

	for (const [name, impls] of implsByName) {
		if (structs.some(s => s.name === name)) continue;

		structs.push({
			name,
			location: ZERO_LOCATION,
			fields: [],
			methods: [],
			path: [name],
			impls,
			prelude: BUILTIN_TYPE_NAMES.has(name) || undefined,
			traits: [],
		});
	}
}

export function parseStdJson(
	stdJson: any,
	externalPreludeNames?: Set<string>,
	traitDefinitions: Map<string, TraitDefinition> = new Map()
): InternalParseStdJsonResult {
	const index = stdJson?.index ?? {};
	const paths = stdJson?.paths ?? {};

	const structs: SharedStruct[] = [];
	const functions: SharedFunction[] = [];
	const blanketImpls: BlanketImpl[] = [];

	const preludeNames = externalPreludeNames ?? buildPreludeNames(index, paths);

	for (const [id, entry] of Object.entries(index)) {
		const parsedStruct = parseStructEntry(entry, index, id, paths, preludeNames);
		if (parsedStruct) {
			structs.push(parsedStruct);
		}
	}

	registerPrimitiveStructs(index, structs);

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
			parseFunctionEntry(entry as any, null, null, functions, { id, paths }, preludeNames);
		}
		parseImplEntry(entry, index, structs, functions, traitDefinitions, blanketImpls);
	}

	const traits = buildStdTraits(index, paths, preludeNames);

	return {
		functions,
		structs,
		traits,
		blanketImpls
	};
}

function mergeStructsByName(structLists: SharedStruct[][]): SharedStruct[] {
	const byName = new Map<string, SharedStruct>();

	for (const list of structLists) {
		for (const s of list) {
			const existing = byName.get(s.name);
			if (!existing) {
				byName.set(s.name, { ...s, methods: [...s.methods], traits: s.traits.map(t => ({ ...t, methods: [...t.methods] })) });
				continue;
			}

			const existingMethodNames = new Set(existing.methods.map(m => m.name));
			for (const method of s.methods) {
				if (!existingMethodNames.has(method.name)) {
					existing.methods.push(method);
					existingMethodNames.add(method.name);
				}
			}
			for (const trait of s.traits) {
				const existingTrait = existing.traits.find(t => t.name === trait.name);
				if (!existingTrait) {
					existing.traits.push({ ...trait, methods: [...trait.methods] });
					continue;
				}
				const existingTraitMethodNames = new Set(existingTrait.methods.map(m => m.name));
				for (const method of trait.methods) {
					if (!existingTraitMethodNames.has(method.name)) {
						existingTrait.methods.push(method);
						existingTraitMethodNames.add(method.name);
					}
				}
			}
			if (existing.fields.length === 0 && s.fields.length > 0) {
				existing.fields = s.fields;
			}
			existing.prelude = existing.prelude ?? s.prelude;
		}
	}

	return [...byName.values()];
}

function mergeTraitsByName(traitLists: Trait[][]): Trait[] {
	const byName = new Map<string, Trait>();

	for (const list of traitLists) {
		for (const t of list) {
			const existing = byName.get(t.name);
			if (!existing) {
				byName.set(t.name, { ...t, methods: [...t.methods] });
				continue;
			}

			const existingMethodNames = new Set(existing.methods.map(m => m.name));
			for (const method of t.methods) {
				if (!existingMethodNames.has(method.name)) {
					existing.methods.push(method);
					existingMethodNames.add(method.name);
				}
			}
			if (existing.path.length === 0 && t.path.length > 0) {
				existing.path = t.path;
			}
			existing.prelude = existing.prelude ?? t.prelude;
		}
	}

	return [...byName.values()];
}

function mergeBlanketImpls(blanketImplLists: BlanketImpl[][]): BlanketImpl[] {
	const byName = new Map<string, BlanketImpl>();

	for (const list of blanketImplLists) {
		for (const b of list) {
			const existing = byName.get(b.traitName);
			if (!existing) {
				byName.set(b.traitName, { ...b, boundTraits: [...b.boundTraits], methods: [...b.methods] });
				continue;
			}

			for (const boundTrait of b.boundTraits) {
				if (!existing.boundTraits.includes(boundTrait)) existing.boundTraits.push(boundTrait);
			}
			const existingMethodNames = new Set(existing.methods.map(m => m.name));
			for (const method of b.methods) {
				if (!existingMethodNames.has(method.name)) {
					existing.methods.push(method);
					existingMethodNames.add(method.name);
				}
			}
		}
	}

	return [...byName.values()];
}

function applyBlanketImpls(structs: SharedStruct[], blanketImpls: BlanketImpl[]): void {
	for (const blanket of blanketImpls) {
		for (const s of structs) {
			if (s.traits.some(t => t.name === blanket.traitName)) continue;
			if (!blanket.boundTraits.some(boundTrait => s.traits.some(t => t.name === boundTrait))) continue;

			s.traits.push({
				name: blanket.traitName,
				location: blanket.location,
				path: blanket.path,
				methods: blanket.methods.map(m => ({ ...m, structName: s.name }))
			});
		}
	}
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
	const traitDefinitions = mergeTraitDefinitions([
		buildTraitDefinitions(stdRaw?.index ?? {}, stdRaw?.paths ?? {}),
		buildTraitDefinitions(allocRaw?.index ?? {}, allocRaw?.paths ?? {}),
		buildTraitDefinitions(coreRaw?.index ?? {}, coreRaw?.paths ?? {}),
	]);

	const std   = parseStdJson(stdRaw,   preludeNames, traitDefinitions);
	const alloc = parseStdJson(allocRaw, preludeNames, traitDefinitions);
	const core  = parseStdJson(coreRaw,  preludeNames, traitDefinitions);

	const structs = mergeStructsByName([std.structs, alloc.structs, core.structs]);
	const functions = [...std.functions, ...alloc.functions, ...core.functions];
	const traits = mergeTraitsByName([std.traits, alloc.traits, core.traits]);

	const blanketImpls = mergeBlanketImpls([std.blanketImpls, alloc.blanketImpls, core.blanketImpls]);
	applyBlanketImpls(structs, blanketImpls);

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

	cachedStdParseResult = { functions, structs, traits };
	return cachedStdParseResult;
}



/// "name": "HashMap",