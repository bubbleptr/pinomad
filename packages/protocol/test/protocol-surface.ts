// Protocol surface snapshot (issue #165, ADR-0018): extract the online types
// with the TypeScript compiler API, normalize them, and keep an append-only
// history. This lives under test/ because packages/protocol/src must stay
// browser-safe (ADR-0024); only the test runner needs the compiler.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { CALL_SINCE, FEATURE_SINCE, HOST_STREAMS, PROTOCOL } from "../src/frames.ts";

export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

export interface ProtocolGateTables {
  readonly call: Readonly<Record<string, number>>;
  readonly stream: Readonly<Record<string, number>>;
  readonly feature: Readonly<Record<string, number>>;
}

export interface ProtocolSurfaceRecord {
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly calls: readonly string[];
  readonly streams: readonly string[];
  readonly gates: ProtocolGateTables;
  readonly surface: Readonly<Record<string, Json>>;
}

export interface ProtocolSurfaceHistory {
  readonly history: readonly ProtocolSurfaceRecord[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "../src");
const CONFIG_PATH = resolve(HERE, "../tsconfig.json");

/** Where the append-only snapshot lives; also exported so the test can write it. */
export const SURFACE_PATH = resolve(HERE, "fixtures/protocol-surface.json");

/**
 * The online roots. Presentation schemas are values, so they are followed
 * through their initializers into the nested schemas (for example
 * TodoSchema -> TodoItemSchema).
 */
const ROOTS = [
  { file: "frames.ts", name: "ClientFrame" },
  { file: "frames.ts", name: "ServerFrame" },
  { file: "frames.ts", name: "CallMethods" },
  { file: "frames.ts", name: "HostStreamValues" },
  { file: "presentation.ts", name: "PresentationType" },
  { file: "presentation.ts", name: "TodoSchema" },
  { file: "presentation.ts", name: "QuestionSchema" },
  { file: "presentation.ts", name: "DiffSchema" },
  { file: "presentation.ts", name: "CodemodeSchema" },
] as const;

interface ProgramSources {
  readonly program: ts.Program;
  readonly rootNames: readonly string[];
}

const compareName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The protocol package's own sources only; test files never declare the wire. */
function isProtocolFile(file: string): boolean {
  const rel = relative(SRC_ROOT, resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function createProgram(sources?: ReadonlyMap<string, string>): ProgramSources {
  const config = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (config.error !== undefined) throw new Error(formatDiagnostics([config.error]));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(CONFIG_PATH), undefined, CONFIG_PATH);
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  const rootNames = parsed.fileNames.filter(isProtocolFile);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  if (sources !== undefined) {
    const overrides = new Map([...sources].map(([file, text]) => [resolve(file), text] as const));
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.readFile = (fileName) => overrides.get(resolve(fileName)) ?? readFile(fileName);
    host.fileExists = (fileName) => overrides.has(resolve(fileName)) || fileExists(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = overrides.get(resolve(fileName));
      return text === undefined
        ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    };
  }
  return { program: ts.createProgram({ rootNames, options, host }), rootNames };
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  });
}

function declName(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (
    (ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isEnumDeclaration(node)
      || ts.isFunctionDeclaration(node))
    && node.name !== undefined
  ) {
    return node.name.text;
  }
  return undefined;
}

function topLevelDeclaration(node: ts.Node): ts.Declaration | undefined {
  if (ts.isVariableDeclaration(node)) return node;
  if (
    ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isFunctionDeclaration(node)
  ) {
    return node;
  }
  return undefined;
}

function findRoot(sourceFiles: ReadonlyMap<string, ts.SourceFile>, file: string, name: string): ts.Declaration {
  const source = sourceFiles.get(resolve(SRC_ROOT, file));
  if (source === undefined) throw new Error("protocol source " + file + " is missing");
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declName(declaration) === name) return declaration;
      }
      continue;
    }
    if (declName(statement) === name) {
      if (
        ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isFunctionDeclaration(statement)
      ) {
        return statement;
      }
    }
  }
  throw new Error("protocol root " + name + " is missing from " + file);
}

/** True for a declaration written in packages/protocol/src. */
function isProtocolDeclaration(node: ts.Node): boolean {
  return isProtocolFile(node.getSourceFile().fileName);
}

function symbolDeclaration(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol.declarations?.find(isProtocolDeclaration);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return "#" + name.text;
  return name.getText();
}

function compareJson(a: Json, b: Json): number {
  return compareName(JSON.stringify(a), JSON.stringify(b));
}

function sortedJson(values: readonly Json[]): Json[] {
  const distinct = new Map<string, Json>();
  for (const value of values) distinct.set(JSON.stringify(value), value);
  return [...distinct.values()].sort(compareJson);
}

interface Serializer {
  type(node: ts.TypeNode): Json;
  expression(node: ts.Expression): Json;
}

/** Extract the current protocol surface. sources lets tests mutate a file in memory. */
export function extractProtocolSurface(options: { readonly sources?: ReadonlyMap<string, string> } = {}): ProtocolSurfaceRecord {
  const { program, rootNames } = createProgram(options.sources);
  const checker = program.getTypeChecker();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const file of rootNames) {
    const source = program.getSourceFile(file);
    if (source !== undefined) sourceFiles.set(resolve(file), source);
  }

  const declarations = new Map<string, Json>();
  const origin = new Map<string, ts.Declaration>();
  const active = new Set<string>();

  const include = (declaration: ts.Declaration): string => {
    const name = declName(declaration);
    if (name === undefined) throw new Error("protocol surface reached an unnamed declaration");
    const prior = origin.get(name);
    if (prior !== undefined) {
      if (prior !== declaration) throw new Error("two protocol declarations share the name " + name);
      return name;
    }
    if (active.has(name)) return name;
    active.add(name);
    declarations.set(name, serializeDeclaration(declaration));
    origin.set(name, declaration);
    active.delete(name);
    return name;
  };

  const local = (node: ts.Node): ts.Declaration | undefined => {
    const declaration = symbolDeclaration(node, checker);
    if (declaration === undefined) return undefined;
    return ts.isTypeParameterDeclaration(declaration) ? declaration : topLevelDeclaration(declaration);
  };

  const reference = (node: ts.Node, args: ts.NodeArray<ts.TypeNode> | undefined, externalName: string): Json => {
    const declaration = local(node);
    if (declaration === undefined) {
      return {
        kind: "external",
        name: externalName,
        ...(args === undefined ? {} : { arguments: args.map((arg) => serializer.type(arg)) }),
      };
    }
    if (ts.isTypeParameterDeclaration(declaration)) {
      return {
        kind: "typeParameter",
        name: declaration.name.text,
        ...(args === undefined ? {} : { arguments: args.map((arg) => serializer.type(arg)) }),
      };
    }
    return {
      kind: "ref",
      name: include(declaration),
      ...(args === undefined ? {} : { arguments: args.map((arg) => serializer.type(arg)) }),
    };
  };

  const typeParameter = (node: ts.TypeParameterDeclaration): Json => ({
    name: node.name.text,
    ...(node.constraint === undefined ? {} : { constraint: serializer.type(node.constraint) }),
    ...(node.default === undefined ? {} : { default: serializer.type(node.default) }),
  });

  const signature = (node: ts.SignatureDeclarationBase): { readonly [key: string]: Json } => ({
    ...(node.typeParameters === undefined ? {} : { typeParameters: node.typeParameters.map(typeParameter) }),
    parameters: node.parameters.map((parameter) => ({
      name: parameter.name.getText(),
      optional: parameter.questionToken !== undefined,
      rest: parameter.dotDotDotToken !== undefined,
      type: parameter.type === undefined ? { kind: "unknown" } : serializer.type(parameter.type),
    })),
    returns: node.type === undefined ? { kind: "unknown" } : serializer.type(node.type),
  });

  const member = (node: ts.TypeElement | ts.ClassElement): Json => {
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      return {
        name: propertyName(node.name),
        optional: node.questionToken !== undefined,
        type: node.type === undefined ? { kind: "unknown" } : serializer.type(node.type),
      };
    }
    if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) {
      return { name: propertyName(node.name), optional: node.questionToken !== undefined, function: signature(node) };
    }
    if (ts.isCallSignatureDeclaration(node)) return { kind: "call", function: signature(node) };
    if (ts.isConstructSignatureDeclaration(node)) return { kind: "construct", function: signature(node) };
    if (ts.isIndexSignatureDeclaration(node)) {
      return {
        kind: "index",
        key: node.parameters[0]?.type === undefined ? { kind: "unknown" } : serializer.type(node.parameters[0].type),
        type: node.type === undefined ? { kind: "unknown" } : serializer.type(node.type),
      };
    }
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return {
        name: propertyName(node.name),
        accessor: ts.isGetAccessorDeclaration(node) ? "get" : "set",
        type: node.type === undefined ? { kind: "unknown" } : serializer.type(node.type),
      };
    }
    throw new Error("unsupported protocol member " + ts.SyntaxKind[node.kind]);
  };

  const members = (nodes: ts.NodeArray<ts.TypeElement | ts.ClassElement>): Json[] =>
    nodes.map(member).sort(compareJson);

  const serializeDeclaration = (declaration: ts.Declaration): Json => {
    if (ts.isInterfaceDeclaration(declaration)) {
      return {
        kind: "interface",
        extends: (declaration.heritageClauses ?? [])
          .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((clause) => clause.types.map((type) => reference(type.expression, type.typeArguments, type.expression.getText())))
          .sort(compareJson),
        members: members(declaration.members),
      };
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return { kind: "type", type: serializer.type(declaration.type) };
    }
    if (ts.isClassDeclaration(declaration)) {
      return {
        kind: "class",
        extends: (declaration.heritageClauses ?? [])
          .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((clause) => clause.types.map((type) => reference(type.expression, type.typeArguments, type.expression.getText()))),
        implements: (declaration.heritageClauses ?? [])
          .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
          .flatMap((clause) => clause.types.map((type) => reference(type.expression, type.typeArguments, type.expression.getText()))),
        members: members(declaration.members),
      };
    }
    if (ts.isEnumDeclaration(declaration)) {
      return {
        kind: "enum",
        members: declaration.members
          .map((entry) => ({
            name: entry.name.getText(),
            ...(entry.initializer === undefined ? {} : { value: serializer.expression(entry.initializer) }),
          }))
          .sort(compareJson),
      };
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (!ts.isIdentifier(declaration.name)) throw new Error("protocol surface reached a destructured variable");
      return {
        kind: "value",
        ...(declaration.type === undefined ? {} : { declared: serializer.type(declaration.type) }),
        initializer: declaration.initializer === undefined ? null : serializer.expression(declaration.initializer),
      };
    }
    if (ts.isFunctionDeclaration(declaration)) {
      return { kind: "function", ...signature(declaration) };
    }
    throw new Error("unsupported protocol declaration " + ts.SyntaxKind[declaration.kind]);
  };

  const literal = (node: ts.Node): Json => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    return { kind: "syntax", text: normalizeText(node.getText()) };
  };

  const tupleElement = (node: ts.TypeNode | ts.NamedTupleMember): Json => {
    if (ts.isNamedTupleMember(node)) {
      return {
        name: node.name.text,
        optional: node.questionToken !== undefined,
        rest: node.dotDotDotToken !== undefined,
        type: serializer.type(node.type),
      };
    }
    if (ts.isOptionalTypeNode(node)) return { optional: true, type: serializer.type(node.type) };
    if (ts.isRestTypeNode(node)) return { rest: true, type: serializer.type(node.type) };
    return serializer.type(node);
  };

  const serializeType = (node: ts.TypeNode): Json => {
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword: return { kind: "primitive", name: "string" };
      case ts.SyntaxKind.NumberKeyword: return { kind: "primitive", name: "number" };
      case ts.SyntaxKind.BooleanKeyword: return { kind: "primitive", name: "boolean" };
      case ts.SyntaxKind.BigIntKeyword: return { kind: "primitive", name: "bigint" };
      case ts.SyntaxKind.SymbolKeyword: return { kind: "primitive", name: "symbol" };
      case ts.SyntaxKind.ObjectKeyword: return { kind: "primitive", name: "object" };
      case ts.SyntaxKind.UndefinedKeyword: return { kind: "primitive", name: "undefined" };
      case ts.SyntaxKind.NeverKeyword: return { kind: "primitive", name: "never" };
      case ts.SyntaxKind.UnknownKeyword: return { kind: "primitive", name: "unknown" };
      case ts.SyntaxKind.AnyKeyword: return { kind: "primitive", name: "any" };
      case ts.SyntaxKind.VoidKeyword: return { kind: "primitive", name: "void" };
      case ts.SyntaxKind.ThisType: return { kind: "this" };
      default: break;
    }
    if (ts.isParenthesizedTypeNode(node)) return serializer.type(node.type);
    if (ts.isLiteralTypeNode(node)) return { kind: "literal", value: literal(node.literal) };
    if (ts.isUnionTypeNode(node)) return { kind: "union", types: sortedJson(node.types.map((type) => serializer.type(type))) };
    if (ts.isIntersectionTypeNode(node)) return { kind: "intersection", types: sortedJson(node.types.map((type) => serializer.type(type))) };
    if (ts.isArrayTypeNode(node)) return { kind: "array", element: serializer.type(node.elementType) };
    if (ts.isTupleTypeNode(node)) return { kind: "tuple", elements: node.elements.map(tupleElement) };
    if (ts.isTypeOperatorNode(node)) {
      if (node.operator === ts.SyntaxKind.ReadonlyKeyword) return serializer.type(node.type);
      if (node.operator === ts.SyntaxKind.KeyOfKeyword) return { kind: "keyof", type: serializer.type(node.type) };
      if (node.operator === ts.SyntaxKind.UniqueKeyword) return { kind: "unique", type: serializer.type(node.type) };
      throw new Error("unsupported type operator " + ts.SyntaxKind[node.operator]);
    }
    if (ts.isTypeQueryNode(node)) {
      const declaration = local(node.exprName);
      return declaration === undefined
        ? { kind: "typeof", name: node.exprName.getText() }
        : { kind: "typeof", name: include(declaration) };
    }
    if (ts.isTypeReferenceNode(node)) {
      return reference(node.typeName, node.typeArguments, node.typeName.getText());
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      return { kind: "indexed", object: serializer.type(node.objectType), index: serializer.type(node.indexType) };
    }
    if (ts.isMappedTypeNode(node)) {
      return {
        kind: "mapped",
        parameter: node.typeParameter.name.text,
        constraint: node.typeParameter.constraint === undefined ? { kind: "unknown" } : serializer.type(node.typeParameter.constraint),
        type: node.type === undefined ? { kind: "unknown" } : serializer.type(node.type),
        optional: node.questionToken !== undefined,
      };
    }
    if (ts.isConditionalTypeNode(node)) {
      return {
        kind: "conditional",
        check: serializer.type(node.checkType),
        extends: serializer.type(node.extendsType),
        true: serializer.type(node.trueType),
        false: serializer.type(node.falseType),
      };
    }
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
      return { kind: ts.isFunctionTypeNode(node) ? "function" : "constructor", ...signature(node) };
    }
    if (ts.isTypeLiteralNode(node)) return { kind: "object", members: members(node.members) };
    if (ts.isTypePredicateNode(node)) {
      return {
        kind: "predicate",
        parameter: node.parameterName.getText(),
        type: node.type === undefined ? null : serializer.type(node.type),
      };
    }
    if (ts.isImportTypeNode(node)) {
      return {
        kind: "import",
        argument: serializer.type(node.argument),
        qualifier: node.qualifier === undefined ? null : node.qualifier.getText(),
      };
    }
    if (ts.isTemplateLiteralTypeNode(node)) {
      return {
        kind: "template",
        head: node.head.text,
        spans: node.templateSpans.map((span) => ({ literal: span.literal.text, type: serializer.type(span.type) })),
      };
    }
    if (ts.isInferTypeNode(node)) return { kind: "infer", name: node.typeParameter.name.text };
    throw new Error("unsupported protocol type " + ts.SyntaxKind[node.kind] + " at " + node.getText().slice(0, 80));
  };

  const typeboxMethod = (expression: ts.Expression): string | undefined => {
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
    return expression.expression.text === "Type" ? expression.name.text : undefined;
  };

  const isTypeboxCall = (node: ts.Expression, method: string): node is ts.CallExpression =>
    ts.isCallExpression(node) && typeboxMethod(node.expression) === method;

  const objectMembers = (properties: ts.NodeArray<ts.ObjectLiteralElementLike>): Json[] =>
    properties.map((property): Json => {
      if (ts.isPropertyAssignment(property)) {
        return { name: propertyName(property.name), value: serializer.expression(property.initializer) };
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return { name: property.name.text, value: serializer.expression(property.name) };
      }
      if (ts.isSpreadAssignment(property)) {
        return { kind: "spread", value: serializer.expression(property.expression) };
      }
      if (ts.isMethodDeclaration(property)) {
        return { name: propertyName(property.name), function: signature(property) };
      }
      throw new Error("unsupported object member " + ts.SyntaxKind[property.kind]);
    }).sort(compareJson);

  const schemaMembers = (properties: ts.NodeArray<ts.ObjectLiteralElementLike>): Json[] =>
    properties.map((property): Json => {
      if (!ts.isPropertyAssignment(property)) throw new Error("schema object members must be property assignments");
      const optional = isTypeboxCall(property.initializer, "Optional");
      return {
        name: propertyName(property.name),
        optional,
        type: serializer.expression(optional ? (property.initializer as ts.CallExpression).arguments[0]! : property.initializer),
      };
    }).sort(compareJson);

  const serializeCall = (node: ts.CallExpression): Json => {
    const method = typeboxMethod(node.expression);
    const argument = (index: number): Json => {
      const value = node.arguments[index];
      return value === undefined ? { kind: "unknown" } : serializer.expression(value);
    };
    if (method === "Object") {
      const value = node.arguments[0];
      if (value === undefined || !ts.isObjectLiteralExpression(value)) return { kind: "call", callee: "Type.Object", arguments: [] };
      return { kind: "object", members: schemaMembers(value.properties) };
    }
    if (method === "Array") {
      return {
        kind: "array",
        element: argument(0),
        ...(node.arguments[1] === undefined ? {} : { options: serializer.expression(node.arguments[1]) }),
      };
    }
    if (method === "Optional") return { kind: "optional", type: argument(0) };
    if (method === "Union") {
      const value = node.arguments[0];
      if (value === undefined || !ts.isArrayLiteralExpression(value)) {
        return { kind: "call", callee: "Type.Union", arguments: node.arguments.map((entry) => serializer.expression(entry)) };
      }
      return { kind: "union", types: sortedJson(value.elements.map((entry) => serializer.expression(entry))) };
    }
    if (method === "Literal") return { kind: "literal", value: argument(0) };
    if (method === "String") return { kind: "string", ...(node.arguments[0] === undefined ? {} : { options: argument(0) }) };
    if (method === "Number") return { kind: "number", ...(node.arguments[0] === undefined ? {} : { options: argument(0) }) };
    if (method === "Boolean") return { kind: "boolean" };
    if (method === "Unknown") return { kind: "unknown" };
    if (method === "Any") return { kind: "any" };
    if (method === "Null") return { kind: "null" };
    if (method === "Undefined") return { kind: "undefined" };
    if (method === "Never") return { kind: "never" };
    if (method !== undefined) {
      return { kind: "call", callee: "Type." + method, arguments: node.arguments.map((entry) => serializer.expression(entry)) };
    }
    return {
      kind: "call",
      callee: serializer.expression(node.expression),
      ...(node.typeArguments === undefined ? {} : { typeArguments: node.typeArguments.map((entry) => serializer.type(entry)) }),
      arguments: node.arguments.map((entry) => serializer.expression(entry)),
    };
  };

  const serializeExpression = (node: ts.Expression): Json => {
    if (ts.isParenthesizedExpression(node)) return serializer.expression(node.expression);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
      return serializer.expression(node.expression);
    }
    if (ts.isObjectLiteralExpression(node)) return { kind: "object", members: objectMembers(node.properties) };
    if (ts.isArrayLiteralExpression(node)) return { kind: "array", elements: node.elements.map((entry) => serializer.expression(entry)) };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isBigIntLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return { kind: "undefined" };
      const declaration = local(node);
      if (declaration === undefined) return { kind: "identifier", name: node.text };
      return { kind: "ref", name: include(declaration) };
    }
    if (ts.isPropertyAccessExpression(node)) {
      return { kind: "property", object: serializer.expression(node.expression), name: node.name.text };
    }
    if (ts.isCallExpression(node)) return serializeCall(node);
    if (ts.isNewExpression(node)) {
      return {
        kind: "new",
        callee: serializer.expression(node.expression),
        arguments: (node.arguments ?? []).map((entry) => serializer.expression(entry)),
      };
    }
    if (ts.isPrefixUnaryExpression(node)) {
      return { kind: "unary", operator: ts.tokenToString(node.operator) ?? String(node.operator), value: serializer.expression(node.operand) };
    }
    if (ts.isBinaryExpression(node)) {
      return {
        kind: "binary",
        operator: node.operatorToken.getText(),
        left: serializer.expression(node.left),
        right: serializer.expression(node.right),
      };
    }
    if (ts.isTemplateExpression(node)) {
      return {
        kind: "template",
        head: node.head.text,
        spans: node.templateSpans.map((span) => ({ literal: span.literal.text, value: serializer.expression(span.expression) })),
      };
    }
    return { kind: "syntax", text: normalizeText(node.getText()) };
  };

  const serializer: Serializer = {
    type: serializeType,
    expression: serializeExpression,
  };

  for (const root of ROOTS) include(findRoot(sourceFiles, root.file, root.name));

  const surface = Object.fromEntries([...declarations.entries()].sort(([a], [b]) => compareName(a, b)));
  return {
    protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor },
    calls: Object.keys(CALL_SINCE).sort(compareName),
    streams: Object.keys(HOST_STREAMS).sort(compareName),
    gates: {
      call: sortedRecord(Object.entries(CALL_SINCE)),
      stream: sortedRecord(Object.entries(HOST_STREAMS)),
      feature: sortedRecord(Object.entries(FEATURE_SINCE)),
    },
    surface,
  };
}

function sortedRecord(entries: readonly (readonly [string, number])[]): Readonly<Record<string, number>> {
  return Object.fromEntries([...entries].sort(([a], [b]) => compareName(a, b)));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function protocolLabel(protocol: { readonly major: number; readonly minor: number }): string {
  return protocol.major + "." + protocol.minor;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1]! >= values[i]!) return false;
  }
  return true;
}

function validateGates(record: ProtocolSurfaceRecord): void {
  const { major, minor } = record.protocol;
  assert(Number.isInteger(major) && major >= 0, "protocol major " + major + " is not a non-negative integer");
  assert(Number.isInteger(minor) && minor >= 0, "protocol minor " + minor + " is not a non-negative integer");
  assert(isSortedUnique(record.calls), "calls in " + protocolLabel(record.protocol) + " must be sorted and unique");
  assert(isSortedUnique(record.streams), "streams in " + protocolLabel(record.protocol) + " must be sorted and unique");
  assert(
    JSON.stringify(record.calls) === JSON.stringify(Object.keys(record.gates.call).sort(compareName)),
    "calls and gates.call disagree in " + protocolLabel(record.protocol),
  );
  assert(
    JSON.stringify(record.streams) === JSON.stringify(Object.keys(record.gates.stream).sort(compareName)),
    "streams and gates.stream disagree in " + protocolLabel(record.protocol),
  );
  for (const table of ["call", "stream", "feature"] as const) {
    for (const [name, since] of Object.entries(record.gates[table])) {
      assert(
        Number.isInteger(since) && since >= 0,
        table + " gate " + name + " in " + protocolLabel(record.protocol) + " is not a non-negative integer",
      );
      assert(
        since <= minor,
        table + " gate " + name + "@" + since + " exceeds protocol " + protocolLabel(record.protocol),
      );
    }
  }
}

function validateTransition(previous: ProtocolSurfaceRecord, current: ProtocolSurfaceRecord): void {
  const from = previous.protocol;
  const to = current.protocol;
  const increased = to.major > from.major || (to.major === from.major && to.minor > from.minor);
  assert(increased, "protocol " + protocolLabel(to) + " does not increase from " + protocolLabel(from));
  if (to.major > from.major) {
    assert(to.minor === 0, "major bump " + protocolLabel(from) + " -> " + protocolLabel(to) + " must reset minor to 0");
    // A new major is a new baseline: deletions and gate changes are expected.
    return;
  }
  for (const name of previous.calls) {
    assert(current.calls.includes(name), "call " + name + " was removed in " + protocolLabel(to));
  }
  for (const name of previous.streams) {
    assert(current.streams.includes(name), "host stream " + name + " was removed in " + protocolLabel(to));
  }
  for (const table of ["call", "stream", "feature"] as const) {
    for (const [name, since] of Object.entries(previous.gates[table])) {
      assert(name in current.gates[table], table + " gate " + name + " was removed in " + protocolLabel(to));
      assert(
        current.gates[table][name] === since,
        table + " gate " + name + " changed from " + since + " to " + current.gates[table][name] + " in " + protocolLabel(to),
      );
    }
    for (const [name, since] of Object.entries(current.gates[table])) {
      if (name in previous.gates[table]) continue;
      assert(
        since > from.minor,
        "new " + table + " gate " + name + "@" + since + " must be greater than " + protocolLabel(from),
      );
    }
  }
}

/** Validate an append-only history: increasing versions, additive gates, no same-major deletions. */
export function validateHistory(history: readonly ProtocolSurfaceRecord[]): void {
  assert(history.length > 0, "protocol surface history is empty");
  history.forEach((record, index) => {
    validateGates(record);
    if (index > 0) validateTransition(history[index - 1]!, record);
  });
}

/**
 * Append current when the protocol version moved. A changed surface at the
 * same version is refused: bump PROTOCOL first, then re-record.
 */
export function recordSurface(history: ProtocolSurfaceHistory, current: ProtocolSurfaceRecord): ProtocolSurfaceHistory {
  if (history.history.length === 0) {
    validateHistory([current]);
    return { history: [current] };
  }
  validateHistory(history.history);
  const last = history.history.at(-1)!;
  if (stableStringify(current) === stableStringify(last)) return history;
  if (current.protocol.major === last.protocol.major && current.protocol.minor === last.protocol.minor) {
    fail(
      "protocol surface changed at " + protocolLabel(current.protocol) + " but PROTOCOL was not bumped; bump PROTOCOL before re-recording",
    );
  }
  const next = [...history.history, current];
  validateHistory(next);
  return { history: next };
}

function sortJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort(compareName)) {
      out[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("cannot normalize " + typeof value);
}

/** Deterministic JSON for writing and comparing history entries. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2) + "\n";
}
