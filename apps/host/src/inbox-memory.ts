// Inbox memory (ADR-0052 §1, §2): per project, under the host's data dir and
// never in the repo. The user's rules (`instructions.md`, read-only to the
// agent), notes about the user and project (`notes/` + `INDEX.md`) and each
// task's progress (`tasks/<id>.md` + `INDEX.md`). The agent reaches them only
// through the memory tools, which cannot leave the directory.
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** `<dataDir>/inbox/<name>-<hash>/memory`: readable by name, unique by the project's full path. */
export function memoryDir(dataDir: string, project: string): string {
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 10);
  return join(dataDir, "inbox", `${basename(project) || "root"}-${hash}`, "memory");
}

const INSTRUCTIONS = "instructions.md";
const MAX_FILE_BYTES = 64 * 1024;

class OutsideMemory extends Error {}

/**
 * The absolute path `path` names inside `dir`, or a throw: absolute paths,
 * `..` and symlinks that lead out of the directory are all refused.
 */
async function inside(dir: string, path: string): Promise<string> {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) throw new OutsideMemory(`${path} is outside the memory`);
  await mkdir(dir, { recursive: true });
  const root = await realpath(dir);
  const target = join(root, clean);
  // Resolve the deepest part that exists: a symlink anywhere on the way counts.
  let existing = target;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  const resolved = await realpath(existing);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new OutsideMemory(`${path} is outside the memory`);
  return target;
}

/** The file's text, or undefined when it does not exist; any other read error is thrown, not mistaken for "no rules". */
async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A file the agent may change: inside the memory, not a symlink, and not the
 * user's rules under any name (a linked directory can make another path reach them).
 */
async function writable(dir: string, path: string): Promise<string> {
  const target = await inside(dir, path);
  const link = await lstat(target).catch(() => undefined);
  if (link?.isSymbolicLink() === true) throw new OutsideMemory(`${path} is a link; memory files are written directly`);
  await mkdir(dirname(target), { recursive: true });
  const real = join(await realpath(dirname(target)), basename(target));
  if (real.toLowerCase() === join(await realpath(dir), INSTRUCTIONS).toLowerCase()) {
    throw new OutsideMemory("instructions.md is the user's; you can read it but not change it.");
  }
  return real;
}

/** The user's rules for the Inbox, `""` when unset. */
export async function readRules(dir: string): Promise<string> {
  return (await readOrUndefined(join(dir, INSTRUCTIONS))) ?? "";
}

/** Replace the user's rules; `""` leaves an empty file. Renamed into place, so a link there is replaced, not followed. */
export async function writeRules(dir: string, rules: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${INSTRUCTIONS}.${process.pid}.tmp`);
  await writeFile(tmp, rules);
  await rename(tmp, join(dir, INSTRUCTIONS));
}

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * How a run ends (ADR-0052 §5): the default is to say little. Fixed bytes, so
 * it stays inside the cached prefix; the user's own rules follow and win.
 */
export const ENDING_A_RUN =
  "Each run ends one of three ways. Finish quietly when the work needed nothing from the user: no message, the result is in the task's conversation and memory. " +
  "Call notify only when the user needs to know something now (something broke, something they asked to hear about happened, work is ready for their review) — once per run at most, and never to report routine progress. " +
  "Ask with ask_user_question when you cannot go on without a decision only the user can make. " +
  "Check the recent notifications first: never tell the user the same thing twice. The user's instructions below override this.";

/**
 * The fixed part of a task's message: the same bytes for every task of the
 * project while the rules and indexes stay unchanged, so the provider's
 * prompt cache can reuse it (ADR-0052 §2). Per-task parts come after it.
 */
export async function memoryPreamble(dir: string): Promise<string> {
  const part = async (tag: string, file: string): Promise<string> => {
    const text = await readOrUndefined(join(dir, file));
    return text === undefined || text.trim() === "" ? `<${tag}/>` : `<${tag}>\n${escape(text.trim())}\n</${tag}>`;
  };
  return [
    ENDING_A_RUN,
    "Your memory for this project is kept between tasks; read and change it with the memory tools.",
    "Keep tasks/<this task's id>.md current with what is done and what is left, and add its line to tasks/INDEX.md with memory_append; do that before you finish a run, as your conversation may be compacted. Put what you learn about the user and the project in notes/ and list it in notes/INDEX.md, again with memory_append: other tasks write the indexes too. Only store what cannot be looked up: point to issues, PRs and commits instead of copying them.",
    await part("instructions", INSTRUCTIONS),
    await part("notes-index", join("notes", "INDEX.md")),
    await part("tasks-index", join("tasks", "INDEX.md")),
  ].join("\n\n");
}

/** The per-task part: the task's own progress file and what the user was already told. */
export async function taskMemory(dir: string, taskId: string, recentlySent: readonly string[]): Promise<string> {
  const path = `tasks/${taskId}.md`;
  const progress = await readOrUndefined(join(dir, "tasks", `${taskId}.md`));
  const sent =
    recentlySent.length === 0
      ? "<recent-notifications/>"
      : `<recent-notifications>\n${recentlySent.map((text) => `- ${escape(text)}`).join("\n")}\n</recent-notifications>`;
  const own = progress === undefined ? `<task-progress path="${path}"/>` : `<task-progress path="${path}">\n${escape(progress.trim())}\n</task-progress>`;
  return `${own}\n\n${sent}`;
}

/** Finds the memory directory of the conversation calling a memory tool; the Inbox supplies it. */
export type MemoryOwner = (conversationId: ConversationId, api: ToolExecutionApi, context: Context) => Promise<string | undefined>;

export const MEMORY_TOOLS: readonly string[] = ["memory_read", "memory_write", "memory_append", "memory_list"];

/** The memory tools; `owner` answers which project's memory a conversation may use, if any. */
export function createMemoryExtension(owner: MemoryOwner): Extension {
  const dirFor = async (api: ToolExecutionApi, context: Context, tool: string): Promise<string> => {
    const dir = await owner(api.conversationId, api, context);
    if (dir === undefined) throw new Error(`${tool} only works in an Inbox task`);
    return dir;
  };
  const refuse = (error: unknown) => {
    if (error instanceof OutsideMemory) return { output: [{ type: "text" as const, text: error.message }] };
    throw error;
  };

  const memoryRead = defineTool({
    name: "memory_read",
    callers: ["model"],
    deferred: true,
    description: "Read a file from this project's Inbox memory, such as notes/INDEX.md or tasks/<id>.md.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, description: "A path inside the memory, such as notes/prefs.md" }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      try {
        const target = await inside(await dirFor(api, context, "memory_read"), args.path);
        const text = await readOrUndefined(target);
        return { output: [{ type: "text", text: text ?? `${args.path} does not exist.` }] };
      } catch (error) {
        return refuse(error);
      }
    },
  });

  const memoryWrite = defineTool({
    name: "memory_write",
    callers: ["model"],
    deferred: true,
    description:
      "Write a whole file in this project's Inbox memory (notes/…, tasks/…). instructions.md is the user's and cannot be written.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "A path inside the memory, such as tasks/<id>.md" }),
      content: Type.String({ description: "The file's new content" }),
    }),
    // Safe: writing the same content again changes nothing.
    replay: "safe",
    execute: async (args, api, context) => {
      try {
        const dir = await dirFor(api, context, "memory_write");
        if (Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) {
          return { output: [{ type: "text", text: `Too long: a memory file holds at most ${MAX_FILE_BYTES / 1024} KB. Keep it short.` }] };
        }
        await writeFile(await writable(dir, args.path), args.content);
        return { output: [{ type: "text", text: `Wrote ${args.path}.` }] };
      } catch (error) {
        return refuse(error);
      }
    },
  });

  const memoryAppend = defineTool({
    name: "memory_append",
    callers: ["model"],
    deferred: true,
    description:
      "Add a line to the end of a file in this project's Inbox memory, such as an entry in tasks/INDEX.md or notes/INDEX.md. Other tasks may be writing the same index; appending never loses their lines, where rewriting the whole file can.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "A path inside the memory, such as tasks/INDEX.md" }),
      line: Type.String({ minLength: 1, maxLength: 1_000, description: "The line to add" }),
    }),
    // Not replay-safe: a rerun would add the line twice.
    execute: async (args, api, context) => {
      try {
        const target = await writable(await dirFor(api, context, "memory_append"), args.path);
        const current = await readOrUndefined(target);
        if (current !== undefined && Buffer.byteLength(current, "utf8") + Buffer.byteLength(args.line, "utf8") > MAX_FILE_BYTES) {
          return { output: [{ type: "text", text: `Too long: ${args.path} would pass ${MAX_FILE_BYTES / 1024} KB. Tidy it with memory_write first.` }] };
        }
        const prefix = current === undefined || current === "" || current.endsWith("\n") ? "" : "\n";
        await appendFile(target, `${prefix}${args.line.replaceAll("\n", " ")}\n`);
        return { output: [{ type: "text", text: `Added a line to ${args.path}.` }] };
      } catch (error) {
        return refuse(error);
      }
    },
  });

  const memoryList = defineTool({
    name: "memory_list",
    callers: ["model"],
    deferred: true,
    description: "List the files in this project's Inbox memory.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const dir = await dirFor(api, context, "memory_list");
      await mkdir(dir, { recursive: true });
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
        .sort();
      return { output: [{ type: "text", text: files.length === 0 ? "The memory is empty." : files.join("\n") }] };
    },
  });

  return defineExtension({ name: "inbox-memory", tools: [memoryRead, memoryWrite, memoryAppend, memoryList] });
}
