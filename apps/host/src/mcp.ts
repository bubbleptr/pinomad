// MCP bridge (ADR-0012): the host reads `~/.agents/mcp.json` once, connects every
// enabled server in the background, and republishes their tools as one `mcp`
// extension — reinstalled in place whenever the tool set changes, so requests
// prepared afterwards see it. Connections live at host level, shared by all
// conversations, and close with the host (stdio children get stdin → SIGTERM →
// SIGKILL from the transport). Mid-session drops mark the server failed and pull
// its tools; v1 does not reconnect.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { McpServerStatus, McpStatus } from "@pinomad/protocol/mcp.ts";

export interface McpBridge {
  /** Latest status; subscribed listeners get every subsequent publication. */
  readonly status: {
    readonly value: McpStatus;
    subscribe(listener: (value: McpStatus) => void): () => void;
  };
  close(): Promise<void>;
}

type ServerSpec =
  | { readonly kind: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly env?: Record<string, string>; readonly cwd?: string }
  | { readonly kind: "http"; readonly url: string; readonly headers?: Record<string, string> };

type ConfigEntry = { readonly name: string } & (
  | { readonly disabled: true }
  | { readonly disabled?: false; readonly spec: ServerSpec; readonly timeoutMs: number }
);

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `${NAME}` expands from the host environment; an unset variable fails the whole server. */
function expand(value: string): string | { missing: string } {
  let missing: string | undefined;
  const expanded = value.replace(ENV_VAR, (_all, name: string) => {
    const found = process.env[name];
    if (found === undefined) missing = name;
    return found ?? "";
  });
  return missing === undefined ? expanded : { missing };
}

function expandAll(values: unknown, field: string, error: (message: string) => void): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  if (!isObject(values)) {
    error(`"${field}" must be an object of strings`);
    return undefined;
  }
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      error(`"${field}.${key}" must be a string`);
      return undefined;
    }
    const result = expand(value);
    if (typeof result !== "string") {
      error(`"${field}.${key}" references unset environment variable ${result.missing}`);
      return undefined;
    }
    expanded[key] = result;
  }
  return expanded;
}

function parseServer(name: string, raw: unknown, error: (message: string) => void): ConfigEntry | undefined {
  const fail = (message: string): undefined => {
    error(`${name}: ${message}`);
    return undefined;
  };
  if (!isObject(raw)) return fail("server entry must be an object");
  if (raw.enabled === false) return { name, disabled: true };
  const timeout =
    raw.timeout === undefined ? 60_000 : typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout * 1000 : undefined;
  if (timeout === undefined) return fail(`"timeout" must be a positive number of seconds`);
  if (raw.command !== undefined || raw.type === "stdio") {
    if (typeof raw.command !== "string" || raw.command === "") return fail(`stdio server needs a "command"`);
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string"))) {
      return fail(`"args" must be an array of strings`);
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return fail(`"cwd" must be a string`);
    const env = expandAll(raw.env, "env", (message) => error(`${name}: ${message}`));
    if (raw.env !== undefined && env === undefined) return undefined;
    // A relative cwd resolves against the user's home, not the host process's.
    const cwd =
      raw.cwd === undefined ? homedir() : isAbsolute(raw.cwd) ? raw.cwd : resolve(homedir(), raw.cwd);
    return {
      name,
      spec: { kind: "stdio", command: raw.command, args: raw.args as string[] | undefined, env, cwd },
      timeoutMs: timeout,
    };
  }
  if (raw.url !== undefined || raw.type === "http" || raw.type === "sse") {
    if (typeof raw.url !== "string" || raw.url === "") return fail(`HTTP server needs a "url"`);
    const headers = expandAll(raw.headers, "headers", (message) => error(`${name}: ${message}`));
    if (raw.headers !== undefined && headers === undefined) return undefined;
    return { name, spec: { kind: "http", url: raw.url, headers }, timeoutMs: timeout };
  }
  return fail(`needs "command" (stdio) or "url" (HTTP)`);
}

async function loadConfig(configPath: string): Promise<{ errors: string[]; entries: ConfigEntry[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    // A missing file is just "no MCP servers"; unreadable or invalid JSON is a config error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { errors: [], entries: [] };
    return { errors: [`${configPath}: ${error instanceof Error ? error.message : String(error)}`], entries: [] };
  }
  if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) {
    return { errors: [`${configPath}: "mcpServers" must be an object`], entries: [] };
  }
  const errors: string[] = [];
  const entries: ConfigEntry[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    const entry = parseServer(name, raw, (message) => errors.push(message));
    if (entry !== undefined) entries.push(entry);
  }
  return { errors, entries };
}

/** `mcp__<server>__<tool>`, provider-safe: [A-Za-z0-9_] only, at most 64 chars. */
const callName = (server: string, tool: string): string => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);

function mcpTool(client: McpClient, timeoutMs: number, name: string, tool: McpTool): ToolRegistration {
  return defineTool({
    name,
    description: tool.description ?? tool.title ?? tool.name,
    // Providers require an object schema, and some reject one without `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties: tool.inputSchema.properties ?? {},
    }),
    // MCP tools may not be idempotent; an interrupted call replays as `interrupted` (ADR-0012 §6).
    execute: async (args, _api, context) => {
      const result = await client.callTool(tool.name, args, { signal: context.abortSignal, timeoutMs });
      return { content: toLlmContent(result), isError: result.isError === true };
    },
  });
}

export function startMcp(options: { configPath: string; registry: Registry }): McpBridge {
  const listeners = new Set<(value: McpStatus) => void>();
  const servers = new Map<string, McpServerStatus>();
  const toolsets = new Map<string, ToolRegistration[]>();
  // Every client ever created, so close() also aborts connections still in flight.
  const live = new Set<McpClient>();
  let errors: string[] = [];
  let closed = false;

  const publish = (): void => {
    const value: McpStatus = { configPath: options.configPath, errors, servers: [...servers.values()] };
    for (const listener of listeners) listener(value);
  };
  const install = (): void => {
    options.registry.install(defineExtension({ name: "mcp", tools: [...toolsets.values()].flat() }));
  };
  const set = (name: string, patch: Partial<McpServerStatus> & Pick<McpServerStatus, "state">): void => {
    servers.set(name, { name, tools: 0, ...servers.get(name), ...patch });
    publish();
  };

  /** Rebuild a connected server's tool registrations; `removed` clears them after a drop. */
  const relist = async (name: string, client: McpClient, timeoutMs: number): Promise<void> => {
    const taken = new Set([...toolsets.entries()].flatMap(([other, tools]) => (other === name ? [] : tools.map((tool) => tool.name))));
    const tools: ToolRegistration[] = [];
    const collisions: string[] = [];
    for (const tool of await client.listTools()) {
      const wire = callName(name, tool.name);
      if (taken.has(wire)) {
        collisions.push(`tool "${tool.name}" collides as ${wire}; skipped`);
        continue;
      }
      taken.add(wire);
      tools.push(mcpTool(client, timeoutMs, wire, tool));
    }
    if (closed) return;
    toolsets.set(name, tools);
    set(name, { state: "connected", tools: tools.length, error: collisions.length === 0 ? undefined : collisions.join("; ") });
    install();
  };

  const fail = (name: string, error: string): void => {
    toolsets.delete(name);
    set(name, { state: "failed", error, tools: 0 });
    install();
  };

  const describeConnectError = (error: unknown, transport: StdioTransport | undefined): string => {
    if (error instanceof McpAuthRequiredError || (error instanceof McpHttpError && error.status === 401)) {
      return "requires sign-in (OAuth), not supported yet";
    }
    const base = error instanceof Error ? error.message : String(error);
    const stderr = transport?.stderr.trim().split("\n").slice(-5).join("\n");
    return stderr === undefined || stderr === "" ? base : `${base}\n${stderr}`;
  };

  const connect = async (name: string, spec: ServerSpec, timeoutMs: number): Promise<void> => {
    const client = new McpClient({ name: "pinomad", version: "0.0.0" });
    live.add(client);
    let stdio: StdioTransport | undefined;
    try {
      const transport =
        spec.kind === "stdio"
          ? (stdio = new StdioTransport({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, stderr: "pipe" }))
          : new StreamableHttpTransport({ url: spec.url, headers: spec.headers });
      await client.connect(transport);
      if (closed) return;
      // The transport's last error is the best hint at why a drop happened.
      let lastError: string | undefined;
      client.onError((error) => {
        lastError = error.message;
      });
      client.onClose(() => {
        if (!closed) fail(name, `disconnected${lastError === undefined ? "" : `: ${lastError}`}`);
      });
      client.onNotification("notifications/tools/list_changed", () => {
        relist(name, client, timeoutMs).catch((error: unknown) => {
          fail(name, error instanceof Error ? error.message : String(error));
        });
      });
      await relist(name, client, timeoutMs);
    } catch (error) {
      live.delete(client);
      if (!closed) fail(name, describeConnectError(error, stdio));
      await client.close().catch(() => {});
    }
  };

  const status = {
    get value(): McpStatus {
      return { configPath: options.configPath, errors, servers: [...servers.values()] };
    },
    subscribe(listener: (value: McpStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  void loadConfig(options.configPath).then((loaded) => {
    if (closed) return;
    errors = loaded.errors;
    for (const entry of loaded.entries) {
      if (entry.disabled === true) servers.set(entry.name, { name: entry.name, state: "disabled", tools: 0 });
      else servers.set(entry.name, { name: entry.name, state: "connecting", tools: 0 });
    }
    publish();
    install();
    for (const entry of loaded.entries) {
      if (entry.disabled === true) continue;
      void connect(entry.name, entry.spec, entry.timeoutMs);
    }
  });

  return {
    status,
    async close() {
      closed = true;
      // A still-connecting client closes its transport, which rejects the
      // pending `connect()`; the loop above then sees `closed` and stops.
      await Promise.all([...live].map((client) => client.close().catch(() => {})));
    },
  };
}
