import { ParserRuleContext } from 'antlr4ng';
import { Borrow, Hole, Param, SourceLocation, Type, ValType, Variable, Function, constructTypeString } from '../../shared/out/types';



export const getSourceLocationKey = (loc: SourceLocation): string => {
	return `${loc.line}:${loc.column}:${loc.length}`;
};

export function getLocation(ctx: ParserRuleContext): SourceLocation {
	const start = ctx.start!;
	const stop = ctx.stop!;
	
	return {
		line: start.line,
		column: start.column,
		length: stop.stop - start.start + 1
	};
}

export function toType(overrides: Partial<Type> & { valType: ValType }, variable?: Variable): Type {
	let primitive = false;
	
	if (overrides.valType === ValType.INT || overrides.valType === ValType.FLOAT) {
		primitive = true;
	}

	const type = new Type();
	type.primitive = primitive;
	type.mutable = false;
	type.consumed = false;
	type.borrows = Borrow.BFree;
	type.structName = overrides.valType;
	Object.assign(type, overrides);
	return type;
}


// structuredClone() drops class prototypes, turning cloned Type instances into plain
// objects that no longer have toTypeString(). These helpers clone while reconstructing
// proper Type instances, for use anywhere state needs to be snapshotted/restored.
export function cloneType(type: Type): Type;
export function cloneType(type: Type | undefined): Type | undefined;
export function cloneType(type: Type | undefined): Type | undefined {
	if (!type) return type;
	const cloned = new Type();
	Object.assign(cloned, type);
	if (type.elementType) {
		cloned.elementType = cloneType(type.elementType);
	}
	// owner intentionally kept as a shallow reference (not deep-cloned): checkBorrows()
	// compares `variable.type.owner === owner` by identity, and owner graphs can be cyclic.
	return cloned;
}

export function cloneVariable(variable: Variable): Variable {
	return { ...variable, type: cloneType(variable.type) };
}

export function cloneParam(param: Param): Param {
	return { ...param, type: cloneType(param.type) };
}

export function cloneFunction(func: Function): Function {
	return { ...func, type: cloneType(func.type), params: func.params.map(cloneParam) };
}

export function formatType (type?: Type): string {
	if (!type) {
		return 'unknown';
	}
	const base = type.valType === ValType.VECTOR
		? `Vec<${type.elementType ? constructTypeString(type.elementType) : 'unknown'}>`
		: type.valType === ValType.REFERENCE
			? `&${type.mutableReference ? 'mut ' : ''}${type.elementType ? constructTypeString(type.elementType) : 'unknown'}`
			: type.valType;
	const mut = type.mutable === true ? 'mut ' : '';
	return `${mut}${base}`;
};

export function printHoleSuggestionContext(hole: Hole): void {
	
	const formatLocation = (loc: SourceLocation): string =>
		`line ${loc.line}, col ${loc.column}, len ${loc.length}`;

	const printSection = (title: string, lines: string[]) => {
		console.log(`${title}:`);
		if (lines.length === 0) {
			console.log('  (none)');
			return;
		}
		lines.forEach(line => console.log(`  ${line}`));
	};

	const formatTypeMetadata = (type?: Type): string => {
		if (!type) {
			return 'unknown';
		}
		const ownerName = type.owner ? type.owner.name : 'none';
		const borrowName = type.borrows === Borrow.BFree ? 'free' : type.borrows === Borrow.BMut ? 'mut' : 'immut';
		return `{
valType: ${type.valType},
structName: ${type.structName ?? 'none'},
elementType: ${type.elementType ? constructTypeString(type.elementType) : 'none'},
primitive: ${type.primitive},
mutable: ${type.mutable},
mutableReference: ${type.mutableReference},
consumed: ${type.consumed},
borrows: ${borrowName},
owner: ${ownerName}
}`;
	};

	console.log('--- Hole suggestion context ---');
	console.log(`Hole location: ${formatLocation(hole.location)}`);
	console.log(`Hole type: ${formatType(hole.type)}`);
	console.log(`Hole type metadata: ${formatTypeMetadata(hole.type)}`);

	const suggestionLines = hole.suggestions.map(suggestion => {
		if (suggestion.suggestionType === 'variable') {
			const variable = suggestion.suggestion as Variable;
			return `variable: ${variable.name} : ${formatType(variable.type)} ${formatTypeMetadata(variable.type)} (${formatLocation(variable.location)})`;
		}
		if (suggestion.suggestionType === 'function') {
			const func = suggestion.suggestion as Function;
			const params = func.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
			return `function: ${func.name}(${params}) -> ${formatType(func.type)} (${formatLocation(func.location)})`;
		}
		if (suggestion.suggestionType === 'method') {
			const method = suggestion.suggestion as Function;
			const params = method.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
			return `method: ${method.name}(${params}) -> ${formatType(method.type)} (${formatLocation(method.location)})`;
		}
		if (suggestion.suggestionType === 'slice') {
			return `slice: ${suggestion.suggestion.name}`;
		}
		return `${suggestion.suggestionType}: ${JSON.stringify(suggestion.suggestion)}`;
	});

	const variableLines = hole.context?.variables.map(variable =>
		`${variable.name}: ${formatType(variable.type)} ${formatTypeMetadata(variable.type)} (${formatLocation(variable.location)})`
	) ?? [];

	const functionLines = hole.context?.functions.map(func => {
		const params = func.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
		return `${func.name}(${params}) -> ${formatType(func.type)} (${formatLocation(func.location)})`;
	}) ?? [];

	printSection('Suggestions', suggestionLines);
	// printSection('Context variables', variableLines);
	// printSection('Context functions', functionLines);
	console.log('--- End hole suggestion context ---\n\n');
}