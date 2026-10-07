// Minimal MCP stdio server for host tests: newline-delimited JSON-RPC, the
// tools the mcp.test.ts cases drive, and a pid file when MCP_FIXTURE_PID is set.
// Runs under `process.execPath` — Node's type stripping or Bun, either works.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

const pidFile = process.env.MCP_FIXTURE_PID;
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: "echo", description: "Echo the given text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "image", description: "Return a 1x1 PNG image", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Return an error result", inputSchema: { type: "object", properties: {} } },
  { name: "add_tool", description: "Register a new tool and announce the change", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exit the server process", inputSchema: { type: "object", properties: {} } },
];

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const call = (name: string | undefined, args: Record<string, unknown> | undefined): object | undefined => {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: String(args?.text ?? "") }] };
    case "image":
      return { content: [{ type: "image", data: PNG, mimeType: "image/png" }] };
    case "fail":
      return { content: [{ type: "text", text: "the tool failed" }], isError: true };
    case "add_tool":
      tools = [...tools, { name: "added", description: "Registered at runtime", inputSchema: { type: "object", properties: {} } }];
      // Notify after the call's response has been written.
      queueMicrotask(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
      return { content: [{ type: "text", text: "tool added" }] };
    case "added":
      return { content: [{ type: "text", text: "added tool ran" }] };
    case "crash":
      process.exit(1);
      return undefined;
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
  if (message.method === undefined || message.id === undefined) return; // response or notification
  let result: object | undefined;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mcp-fixture", version: "0.0.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools };
      break;
    case "tools/call":
      result = call(message.params?.name, message.params?.arguments);
      break;
    case "roots/list":
      result = { roots: [] };
      break;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
      return;
  }
  if (result !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
});
