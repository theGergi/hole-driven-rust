import { ParserRuleContext } from 'antlr4ng';
import { Borrow, Hole, SourceLocation, Type, ValType, Variable, Function } from '../../shared/types';



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
	console.log(overrides)
	
	if (overrides.valType === ValType.INT) {
		primitive = true;
	}

	const type = new Type();
	type.primitive = primitive;
	type.mutable = false;
	type.consumed = false;
	type.borrows = Borrow.BFree;
	Object.assign(type, overrides);
	return type;
}



export function printHoleSuggestionContext(hole: Hole): void {
	const formatType = (type?: Type): string => {
		if (!type) {
			return 'unknown';
		}
		const base = type.valType === ValType.VECTOR
			? `Vec<${type.elementType ?? 'unknown'}>`
			: type.valType === ValType.REFERENCE
				? `&${type.mutableReference ? 'mut ' : ''}${type.elementType ?? 'unknown'}`
				: type.valType;
		const mut = type.mutable === true ? 'mut ' : '';
		return `${mut}${base}`;
	};

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
elementType: ${type.elementType ?? 'none'},
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
	printSection('Context variables', variableLines);
	printSection('Context functions', functionLines);
	console.log('--- End hole suggestion context ---\n\n');
}