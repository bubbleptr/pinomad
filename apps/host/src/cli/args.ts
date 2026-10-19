// node:util's parseArgs reports every user-facing argument error with an
// ERR_PARSE_ARGS_* code (unknown option, missing value, stray positional).
// The `pinomad` dispatcher turns these into a one-line error + exit 2, so a
// subcommand that swallows errors (service's catch-all, restartService's
// "address unknown" fallback) must rethrow them instead of handling them.
export function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}
