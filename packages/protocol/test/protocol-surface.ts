// Protocol surface snapshot (issue #165, ADR-0018): collect the online types
// with the TypeScript compiler API, print each declaration in a normalized
// form, and keep an append-only history. This lives under test/ because
// packages/protocol/src must stay browser-safe (ADR-0024).
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { CALL_SINCE, FEATURE_SINCE, HOST_STREAMS, PROTOCOL } from "../src/frames.ts";

export type SurfaceText = Readonly<Record<string, string>>;

export interface ProtocolGateTables {
  readonly call: Readonly<Record<string, number>>;
  readonly stream: Readonly<Record<string, number>>;
  readonly feature: Readonly<Record<string, number>>;
}

export interface ProtocolSurfaceBase {
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly calls: readonly string[];
  readonly streams: readonly string[];
  readonly gates: ProtocolGateTables;
}

/** The newest record carries the full surface; older records keep only its hash. */
export interface ProtocolSurfaceEntry extends ProtocolSurfaceBase {
  readonly surface: SurfaceText;
}

export interface ProtocolSurfaceArchive extends ProtocolSurfaceBase {
  readonly surfaceHash: string;
}

export type ProtocolSurfaceRecord = ProtocolSurfaceEntry | ProtocolSurfaceArchive;

export interface ProtocolSurfaceHistory {
  readonly history: readonly ProtocolSurfaceRecord[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "../src");
const CONFIG_PATH = resolve(HERE, "../tsconfig.json");

/** Where the append-only snapshot lives; also exported so the test can write it. */
export const SURFACE_PATH = resolve(HERE, "fixtures/protocol-surface.json");

/**
 * The online roots. Presentation schemas are values, so the reference walk
 * follows their initializers into the nested schemas (for example
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
const printer = ts.createPrinter({ removeComments: true });

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

function nodeSortText(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (
    ts.isPropertyAssignment(node)
    || ts.isPropertySignature(node)
    || ts.isPropertyDeclaration(node)
    || ts.isMethodSignature(node)
    || ts.isMethodDeclaration(node)
  ) {
    return node.name.getText(sourceFile);
  }
  return node.getText(sourceFile);
}

function sortedNodes<T extends ts.Node>(nodes: ts.NodeArray<T>, sourceFile: ts.SourceFile): ts.NodeArray<T> {
  const sorted = [...nodes].sort((a, b) => compareName(nodeSortText(a, sourceFile), nodeSortText(b, sourceFile)));
  return ts.factory.createNodeArray(sorted, nodes.hasTrailingComma);
}

/**
 * Normalize a declaration for printing: drop readonly, sort object members
 * and union members, and leave references as names. The printer then handles
 * every syntax the protocol grows into, including initializer expressions.
 */
function surfaceTransformer(sourceFile: ts.SourceFile): ts.TransformerFactory<ts.Node> {
  return (context) => {
    const visitor: ts.Visitor = (node) => {
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
        return ts.visitNode(node.type, visitor) ?? node.type;
      }
      if (ts.isMappedTypeNode(node) && node.readonlyToken !== undefined) {
        return ts.visitEachChild(
          ts.factory.updateMappedTypeNode(node, undefined, node.typeParameter, node.nameType, node.questionToken, node.type, node.members),
          visitor,
          context,
        );
      }
      if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) {
          const withoutReadonly = modifiers.filter((modifier) => modifier.kind !== ts.SyntaxKind.ReadonlyKeyword);
          return ts.visitEachChild(ts.factory.replaceModifiers(node, withoutReadonly), visitor, context);
        }
      }
      if (ts.isUnionTypeNode(node)) {
        return ts.visitEachChild(ts.factory.updateUnionTypeNode(node, sortedNodes(node.types, sourceFile)), visitor, context);
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "Type"
        && node.expression.name.text === "Union"
      ) {
        const value = node.arguments[0];
        if (value !== undefined && ts.isArrayLiteralExpression(value)) {
          const sorted = ts.factory.updateArrayLiteralExpression(value, sortedNodes(value.elements, sourceFile));
          return ts.visitEachChild(
            ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [sorted]),
            visitor,
            context,
          );
        }
      }
      if (ts.isTypeLiteralNode(node)) {
        return ts.visitEachChild(ts.factory.updateTypeLiteralNode(node, sortedNodes(node.members, sourceFile)), visitor, context);
      }
      if (ts.isInterfaceDeclaration(node)) {
        return ts.visitEachChild(
          ts.factory.updateInterfaceDeclaration(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            sortedNodes(node.members, sourceFile),
          ),
          visitor,
          context,
        );
      }
      if (ts.isObjectLiteralExpression(node)) {
        return ts.visitEachChild(
          ts.factory.updateObjectLiteralExpression(node, sortedNodes(node.properties, sourceFile)),
          visitor,
          context,
        );
      }
      if (ts.isClassDeclaration(node)) {
        return ts.visitEachChild(
          ts.factory.updateClassDeclaration(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            sortedNodes(node.members, sourceFile),
          ),
          visitor,
          context,
        );
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return (root) => ts.visitNode(root, visitor) as ts.Node;
  };
}

function printDeclaration(declaration: ts.Declaration): string {
  const sourceFile = declaration.getSourceFile();
  const parent = declaration.parent;
  const statement = ts.isVariableDeclaration(declaration) && ts.isVariableStatement(parent.parent)
    ? parent.parent
    : declaration;
  const result = ts.transform(statement, [surfaceTransformer(sourceFile)]);
  try {
    return printer.printNode(ts.EmitHint.Unspecified, result.transformed[0]!, sourceFile).trim();
  } finally {
    result.dispose();
  }
}

/** Extract the current protocol surface. sources lets tests mutate a file in memory. */
export function extractProtocolSurface(options: { readonly sources?: ReadonlyMap<string, string> } = {}): ProtocolSurfaceEntry {
  const { program, rootNames } = createProgram(options.sources);
  const checker = program.getTypeChecker();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const file of rootNames) {
    const source = program.getSourceFile(file);
    if (source !== undefined) sourceFiles.set(resolve(file), source);
  }

  const collected = new Map<string, ts.Declaration>();
  const active = new Set<string>();

  const local = (node: ts.Node): ts.Declaration | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        return undefined;
      }
    }
    const declaration = symbol.declarations?.find(isProtocolDeclaration);
    return declaration === undefined ? undefined : topLevelDeclaration(declaration);
  };

  const include = (declaration: ts.Declaration): string => {
    const name = declName(declaration);
    if (name === undefined) throw new Error("protocol surface reached an unnamed declaration");
    const prior = collected.get(name);
    if (prior !== undefined) {
      if (prior !== declaration) throw new Error("two protocol declarations share the name " + name);
      return name;
    }
    if (active.has(name)) return name;
    active.add(name);
    collected.set(name, declaration);
    visit(declaration);
    active.delete(name);
    return name;
  };

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const declaration = local(node);
      if (declaration !== undefined) include(declaration);
    }
    ts.forEachChild(node, visit);
  }

  for (const root of ROOTS) include(findRoot(sourceFiles, root.file, root.name));

  const surface = Object.fromEntries(
    [...collected.entries()]
      .map(([name, declaration]) => [name, printDeclaration(declaration)] as const)
      .sort(([a], [b]) => compareName(a, b)),
  );
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

function validateGates(record: ProtocolSurfaceBase): void {
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

function hasSurface(record: ProtocolSurfaceRecord): record is ProtocolSurfaceEntry {
  return "surface" in record;
}

function validateHistoryShape(history: readonly ProtocolSurfaceRecord[]): void {
  history.forEach((record, index) => {
    validateGates(record);
    if (index === history.length - 1) {
      assert(hasSurface(record), "the last history entry must carry the full surface");
      assert(!("surfaceHash" in record), "the last history entry must not carry surfaceHash");
      for (const [name, text] of Object.entries(record.surface)) {
        assert(name.length > 0 && typeof text === "string" && text.length > 0, "surface entry " + name + " must be a non-empty string");
      }
      return;
    }
    if (hasSurface(record)) fail("only the last history entry may carry the full surface");
    const hash = record.surfaceHash;
    assert(
      typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
      "history entry " + protocolLabel(record.protocol) + " must carry a sha256 surfaceHash",
    );
  });
}

function validateTransition(previous: ProtocolSurfaceBase, current: ProtocolSurfaceBase): void {
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
  validateHistoryShape(history);
  history.forEach((record, index) => {
    if (index > 0) validateTransition(history[index - 1]!, record);
  });
}

function archive(entry: ProtocolSurfaceEntry): ProtocolSurfaceArchive {
  const { surface, ...base } = entry;
  return { ...base, surfaceHash: hashSurface(surface) };
}

/**
 * Append current when the protocol version moved, compacting the previous
 * record to a hash. A changed surface at the same version is refused: bump
 * PROTOCOL first, then re-record.
 */
export function recordSurface(history: ProtocolSurfaceHistory, current: ProtocolSurfaceEntry): ProtocolSurfaceHistory {
  if (history.history.length === 0) {
    validateHistory([current]);
    return { history: [current] };
  }
  validateHistory(history.history);
  const last = history.history.at(-1)!;
  if (!hasSurface(last)) fail("the last history entry must carry the full surface");
  if (stableStringify(current) === stableStringify(last)) return history;
  if (current.protocol.major === last.protocol.major && current.protocol.minor === last.protocol.minor) {
    fail(
      "protocol surface changed at " + protocolLabel(current.protocol) + " but PROTOCOL was not bumped; bump PROTOCOL before re-recording",
    );
  }
  const next = [...history.history.slice(0, -1), archive(last), current];
  validateHistory(next);
  return { history: next };
}

/** sha256 of the normalized surface, so older records can stay compact. */
export function hashSurface(surface: SurfaceText): string {
  return createHash("sha256").update(stableStringify(surface)).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
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
