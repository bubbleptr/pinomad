// Host-declared slash commands (5.17, ADR-0029): `/name` runs on the host and
// never reaches the model, unlike a `$skill` mention. The host lists them per
// conversation; clients never hard-code a command table.

/** One command a `/` menu may offer. */
export interface CommandInfo {
  /** Typed after the `/`, without it. */
  readonly name: string;
  readonly description: string;
  /** What may follow the name, for the menu — `[instructions]`. */
  readonly argumentHint?: string;
  /** Who declared it: the host itself, or (later) a plugin. */
  readonly source: "builtin" | "plugin";
  /** Set when the command exists but can't run now: the reason, shown greyed out. */
  readonly disabled?: string;
}

/** One `listCommands` answer, in menu order. */
export interface CommandListing {
  readonly commands: readonly CommandInfo[];
}
