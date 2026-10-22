// Worktree materialization as a reader sees it: `git worktree add` creates the
// directory (and its `.git` file) before checking the files out, so a listing
// that only stats the path can read a half-written checkout.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ensureWorktree, worktreeSettled } from "../src/checkout.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();
const run = promisify(execFile);

it("worktreeSettled waits out an in-flight checkout and never creates one", async () => {
  const repo = await tempDir();
  defer(repo.remove);
  const data = await tempDir();
  defer(data.remove);
  await run("git", ["-C", repo.path, "init", "-b", "main"]);
  await mkdir(join(repo.path, ".agents", "skills", "review"), { recursive: true });
  await writeFile(join(repo.path, ".agents", "skills", "review", "SKILL.md"), "review\n");
  await run("git", ["-C", repo.path, "add", "-A"]);
  await run("git", ["-C", repo.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  const { stdout } = await run("git", ["-C", repo.path, "rev-parse", "HEAD"]);
  const record = (id: number) => ({
    conversationId: id as ConversationId,
    path: join(data.path, "worktrees", String(id)),
    repo: repo.path,
    subdir: "",
    branch: `pinomad/${id}-test`,
    base: stdout.trim(),
  });

  // Nothing materializing: the reader reports the checkout missing, and it stays missing.
  expect(await worktreeSettled(record(1))).toBe(false);
  expect(await worktreeSettled(record(1))).toBe(false);

  // Materializing: the reader resolves only once the files are on disk.
  const creating = ensureWorktree(record(2));
  expect(await worktreeSettled(record(2))).toBe(true);
  expect(await readFile(join(record(2).path, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe("review\n");
  await creating;
});
