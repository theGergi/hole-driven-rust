"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Type = exports.Borrow = exports.ValType = void 0;
exports.constructTypeString = constructTypeString;
var ValType;
(function (ValType) {
    ValType["ROOT"] = "ROOT";
    ValType["INT"] = "integer";
    ValType["STRING"] = "string";
    ValType["HOLE"] = "HOLE";
    ValType["UNKNOWN"] = "UNKNOWN";
    ValType["VECTOR"] = "Vec";
    ValType["REFERENCE"] = "reference";
    ValType["STRUCT"] = "struct";
    ValType["RANGE"] = "range";
    ValType["VOID"] = "void";
})(ValType || (exports.ValType = ValType = {}));
var Borrow;
(function (Borrow) {
    Borrow[Borrow["BFree"] = 0] = "BFree";
    Borrow[Borrow["BMut"] = 1] = "BMut";
    Borrow[Borrow["BImmut"] = 2] = "BImmut";
})(Borrow || (exports.Borrow = Borrow = {}));
class Type {
    elementType; // For vectors and references
    valType;
    primitive;
    mutable;
    mutableReference; // Only for references, indicates if the reference itself is mutable (e.g., &mut T vs &T)
    consumed;
    borrows;
    owner;
    structName; // For struct types
    toTypeString() {
        return constructTypeString(this);
    }
}
exports.Type = Type;
function constructTypeString(type) {
    let typeString = "";
    if (type.valType === 'reference') {
        typeString += "&";
        if (type.mutableReference) {
            typeString += "mut ";
        }
        if (type.elementType === 'struct') {
            typeString += type.structName;
        }
        else {
            typeString += type.elementType;
        }
    }
    else if (type.valType === 'Vec') {
        typeString += "Vec " + type.elementType;
    }
    else if (type.valType === 'struct') {
        typeString += type.structName;
    }
    else {
        typeString += type.valType;
    }
    return typeString;
}
//# sourceMappingURL=types.js.map