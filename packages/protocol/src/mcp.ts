// MCP server status pushed over the host-level `mcp` stream (ADR-0012 §8).

export interface McpServerStatus {
  readonly name: string;
  readonly state: "connecting" | "connected" | "failed" | "disabled";
  readonly error?: string;
  readonly tools: number;
}

export interface McpStatus {
  /** The file the host read; edit it and restart the host to apply. */
  readonly configPath: string;
  /** Config-level errors: an unreadable file or a malformed server entry. */
  readonly errors: readonly string[];
  readonly servers: readonly McpServerStatus[];
}
