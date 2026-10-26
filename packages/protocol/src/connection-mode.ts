// Connection mode shared by the TS coordinator, the Rust core, and stored
// hosts (ADR-0033 §3). Missing in a stored record means "auto", so an old
// record keeps the behaviour it had.
export type ConnectionMode = "auto" | "directOnly" | "relayOnly";

export function parseConnectionMode(value: unknown): ConnectionMode | undefined {
  return value === "auto" || value === "directOnly" || value === "relayOnly" ? value : undefined;
}
