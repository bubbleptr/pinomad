// The code a host prints for `pinomad join <origin>` without a token (#495):
// eight letters, shown XXXX-XXXX. People type it from another screen, so the
// input takes it in any case, with or without the dash and spaces; the server
// ignores those too.

const LENGTH = 8;

/** The code's letters, uppercased, everything else dropped, at most eight. */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, "").slice(0, LENGTH);
}

/** XXXX-XXXX, the way the host's terminal shows it; a partial code gets the dash once it's past four. */
export function formatUserCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function isCompleteUserCode(code: string): boolean {
  return code.length === LENGTH;
}
