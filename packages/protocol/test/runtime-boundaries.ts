// Mechanical check for the browser-and-Node rule of packages/protocol and
// packages/client (ADR-0017, ADR-0024). tsc can't enforce it: @types/node is
// pulled into every program by undici-types' `/// <reference types="node" />`
// (via @anthropic-ai/sdk under pi-ai), so `Buffer` type-checks even with
// `"types": []`. Instead this resolves every identifier in the package's src
// with the type checker and reports globals that only Node (or only the DOM)
// declares, plus imports of Node builtins (or React).
import { readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface BoundaryRules {
  /** Also forbid DOM-only globals and React imports (packages/client). */
  readonly noDom: boolean;
}

type Origin = "node" | "dom" | "other";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function origin(file: string): Origin {
  if (file.includes(`${sep}@types${sep}node${sep}`) || file.includes(`${sep}undici-types${sep}`)) return "node";
  if (/[\\/]typescript[\\/]lib[\\/]lib\.dom[.\w]*\.d\.ts$/.test(file)) return "dom";
  return "other";
}

/** Declared at global scope: top level of a script, or inside `declare global`. */
function isGlobal(declaration: ts.Declaration): boolean {
  let statement: ts.Node = declaration;
  if (ts.isVariableDeclaration(statement)) statement = statement.parent.parent;
  const container = statement.parent;
  if (ts.isSourceFile(container)) return !ts.isExternalModule(container);
  return ts.isModuleBlock(container) && container.parent.name.text === "global";
}

function forbiddenModule(specifier: string, rules: BoundaryRules): string | undefined {
  if (specifier.startsWith("node:") || builtinModules.includes(specifier)) return "Node builtin module";
  if (rules.noDom && /^react(-dom)?(\/|$)/.test(specifier)) return "React";
  return undefined;
}

function moduleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0];
  }
  return undefined;
}

/** `file:line  text  (reason)` for each violation under `srcDir`. */
export function runtimeBoundaryViolations(srcDir: string, rules: BoundaryRules): string[] {
  const files = sourceFiles(srcDir);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    // Both libs are loaded so a global both runtimes declare (setTimeout,
    // fetch, URL, TextEncoder, crypto...) resolves to both and is allowed.
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: ["node"],
  });
  const checker = program.getTypeChecker();
  const violations: string[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file)!;
    const report = (node: ts.Node, reason: string) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${relative(REPO_ROOT, file)}:${line + 1}  ${node.getText(source)}  (${reason})`);
    };

    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifier(node);
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const reason = forbiddenModule(specifier.text, rules);
        if (reason) report(specifier, reason);
      }
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        const declarations = symbol?.declarations ?? [];
        if (declarations.length > 0 && declarations.every(isGlobal)) {
          const origins = new Set(declarations.map((d) => origin(d.getSourceFile().fileName)));
          if (origins.size === 1 && origins.has("node")) report(node, "Node-only global");
          if (rules.noDom && origins.size === 1 && origins.has("dom")) report(node, "DOM-only global");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
