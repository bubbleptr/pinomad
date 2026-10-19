// node:util's parseArgs reports every user-facing argument error with an
// ERR_PARSE_ARGS_* code (unknown option, missing value, stray positional).
// These mean "the user typed it wrong": the answer is a two-line report and
// exit 2, never a stack. Subcommands that swallow errors (service's
// catch-all, restartService's "address unknown" fallback) must rethrow them
// so an entry point can report them instead.
export function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/**
 * `<command>: <parseArgs message>` then the --help hint, on stderr, exit 2.
 * `command` is the spelling the user typed: `pinomad pair` from the
 * dispatcher, `commandHint("service")` from a dev entry.
 */
export function reportParseArgsError(command: string, error: unknown): void {
  console.error(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`run "${command} --help" for usage`);
  process.exitCode = 2;
}
