// codemode extension (ADR-0013): upstream Durable code mode. One `codemode`
// tool runs model-written JavaScript in a QuickJS sandbox; scripts call the
// conversation's callable tools as `tools.<name>(args)` — real nested tool
// calls — and a restart resumes the script by deterministic replay instead of
// interrupting it. The tool already restricts itself to `callers: ["model"]`,
// so scripts cannot start scripts.
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { BuiltinExtension } from "../builtin-extension.ts";

// The wasm module is shared across calls; load it once per process.
const wasm = loadQuickJSWasm();

export function createCodemode(): BuiltinExtension {
  // One sandbox per host: a worker thread per execution, shared tool table.
  const sandbox = new CodemodeSandbox({ wasm, memoryLimitBytes: 256 * 1024 * 1024 });
  const namespaced = (namespaces: readonly CodemodeNamespace[]): Extension =>
    createCodemodeExtension({ sandbox, namespaces });
  return {
    extension: namespaced([]),
    tools: { codemode: "pinomad.codemode" },
    // MCP servers come and go; the codemode extension is reinstalled with the
    // current namespaces so the prompt section and tool search see them.
    namespaced,
    close: () => sandbox.close(),
  };
}
