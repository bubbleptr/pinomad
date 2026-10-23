// Slash-command recognition (issue #254, ADR-0029): whether a composer's text
// is a host-declared command rather than a message. Lexical only, so the Web
// composer and iOS (through the Rust mirror) agree: the text must start with
// `/` at index 0 — no leading whitespace is skipped, `hello /compact` is a
// message; the token after it, up to the first Unicode whitespace
// (`\p{White_Space}`, the set Rust's `char::is_whitespace` uses), must equal a
// listed name exactly, case-sensitive — so `/compactX`, `/compact.`,
// `/usr/bin/x` and an unknown `/foo` are messages. The rest, with
// `\p{White_Space}` stripped from both ends, is `args`; it is omitted when
// empty. The trim is spelled out rather than `String.prototype.trim`, which
// also strips U+FEFF and would drift from the Rust side. A `disabled` command
// still parses — what to do with it is the caller's call.

export interface CommandInput {
  readonly name: string;
  /** The text after the name, trimmed; absent when there is none. */
  readonly args?: string;
}

const WHITESPACE = /\p{White_Space}/u;

// White_Space is all BMP, so a UTF-16 unit check is a char check.
const isSpace = (text: string, index: number): boolean => WHITESPACE.test(text[index]!);

export function parseCommandInput(text: string, commands: readonly { readonly name: string }[]): CommandInput | undefined {
  if (text.charCodeAt(0) !== 0x2f) return undefined; // /
  let end = 1;
  while (end < text.length && !isSpace(text, end)) end += 1;
  const name = text.slice(1, end);
  if (name === "" || !commands.some((command) => command.name === name)) return undefined;
  let start = end;
  let stop = text.length;
  while (start < stop && isSpace(text, start)) start += 1;
  while (stop > start && isSpace(text, stop - 1)) stop -= 1;
  return start === stop ? { name } : { name, args: text.slice(start, stop) };
}
