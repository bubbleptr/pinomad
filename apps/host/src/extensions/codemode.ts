// codemode extension (ADR-0013): upstream Durable code mode. One `codemode`
// tool runs model-written JavaScript in a QuickJS sandbox; scripts call the
// conversation's callable tools as `tools.<name>(args)` — real nested tool
// calls — and a restart resumes the script by deterministic replay instead of
// interrupting it. The tool already restricts itself to `callers: ["model"]`,
// so scripts cannot start scripts.
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { BuiltinExtension } from "../builtin-extension.ts";

// The wasm module is shared across calls; load it once per process.
const wasm = loadQuickJSWasm();

export function createCodemode(): BuiltinExtension {
  // One sandbox per host: a worker thread per execution, shared tool table.
  const sandbox = new CodemodeSandbox({ wasm, memoryLimitBytes: 256 * 1024 * 1024 });
  return {
    // Namespaces come from the extensions that bring the tools (each MCP server's `namespace`).
    extension: createCodemodeExtension({ sandbox }),
    tools: { codemode: "pinomad.codemode" },
    close: () => sandbox.close(),
  };
}
