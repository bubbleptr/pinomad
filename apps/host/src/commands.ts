// Host-declared slash commands (issue #254, ADR-0029). pi-durable has no
// command concept — `Conversation.compact()` and friends are plain methods —
// so PiNomad declares its own: clients list these with `listCommands` and
// run one with `runCommand`; they never keep a table of their own.
import type { CommandInfo, CommandListing } from "@pinomad/protocol/commands.ts";

/** What a command may do to the conversation it runs in. */
export interface CommandTarget {
  /** Start a manual compaction; the gateway reports its outcome as a notice. */
  compact(instructions: string | undefined): Promise<unknown>;
}

interface HostCommand {
  readonly info: CommandInfo;
  run(target: CommandTarget, args: string | undefined): Promise<void>;
}

const BUILTIN_COMMANDS: readonly HostCommand[] = [
  {
    info: {
      name: "compact",
      description: "Summarize older context to free up space",
      argumentHint: "[instructions]",
      source: "builtin",
    },
    run: async (target, args) => {
      await target.compact(args?.trim() || undefined);
    },
  },
];

export function listCommands(): CommandListing {
  return { commands: BUILTIN_COMMANDS.map((command) => command.info) };
}

export async function runCommand(target: CommandTarget, name: string, args: string | undefined): Promise<void> {
  const command = BUILTIN_COMMANDS.find((candidate) => candidate.info.name === name);
  if (command === undefined) throw new Error(`Unknown command: /${name}`);
  await command.run(target, args);
}
