// The script-reachable tool catalog (ADR-0013 §2): tools with `codemode`
// exposure never enter `agent.tools`, but the host keeps them here and the
// codemode extension resolves `tools.<name>` calls against this list.
// `scriptTools()` is read per call, so providers (the MCP bridge) may connect
// and add tools after the extension was installed.

/** An MCP server as the scripts see it: a named group with optional docs. */
export interface ScriptNamespace {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
}

/** A tool callable from codemode scripts, regardless of model exposure. */
export interface ScriptTool {
  /** The wire name scripts resolve — `mcp__<server>__<tool>` for MCP. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Drives the declaration `describeTool` renders; MCP tools carry a CallToolResult shape. */
  readonly outputSchema?: Record<string, unknown>;
  readonly namespace?: ScriptNamespace;
  /** Resolves to the value the script sees; rejections surface as script Errors. */
  call(args: unknown, signal: AbortSignal): Promise<unknown>;
}
