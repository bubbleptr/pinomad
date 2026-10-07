import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPatch } from "diff";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../src/presentation/diff.tsx";

const run = promisify(execFile);
const git = (dir: string, args: readonly string[]) => run("git", ["-C", dir, ...args]).then(({ stdout }) => stdout);

/**
 * A real `git diff --cached` output covering the header shapes git emits:
 * modified, added, deleted, rename+edit, binary, mode change, and body lines
 * that collide with header prefixes.
 */
async function realDiff(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pinomad-diff-"));
  try {
    await git(repo, ["init", "-b", "main"]);
    const commit = () => git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "x"]);
    await writeFile(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
    await writeFile(join(repo, "doomed.txt"), "gone\n");
    await writeFile(join(repo, "old-name.txt"), "rename me\nkeep\n");
    await writeFile(join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
    await writeFile(join(repo, "comments.sql"), "SELECT 1\n-- comment\nSELECT 2\n");
    await git(repo, ["add", "-A"]);
    await commit();

    // modified file; deleted file; new file; rename with an edit; mode change; binary
    await writeFile(join(repo, "tracked.txt"), "one\nTWO\nthree\n");
    await rm(join(repo, "doomed.txt"));
    await writeFile(join(repo, "new.txt"), "fresh\nlines\n");
    await run("git", ["-C", repo, "mv", "old-name.txt", "new-name.txt"]);
    await writeFile(join(repo, "new-name.txt"), "rename me\nkeep\nedited\n");
    await run("chmod", ["+x", join(repo, "script.sh")]);
    await writeFile(join(repo, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await writeFile(join(repo, "comments.sql"), "SELECT 1\n++ x\nSELECT 2\n");
    await git(repo, ["add", "-A"]);
    return await git(repo, ["diff", "--cached", "--no-color", "--find-renames", "HEAD"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe("parsePatch", () => {
  it("parses real git diff output: one entry per file with correct flags and counts", async () => {
    const patch = await realDiff();
    const files = parsePatch(patch);
    const byPath = new Map(files.map((file) => [file.path, file]));

    // One entry per file — a new file must not split into two.
    expect(files).toHaveLength(7);
    expect(byPath.get("tracked.txt")).toMatchObject({ additions: 1, deletions: 1, isNew: false, isDeleted: false });
    expect(byPath.get("doomed.txt")).toMatchObject({ isDeleted: true, deletions: 1 });
    expect(byPath.get("new.txt")).toMatchObject({ isNew: true, additions: 2, deletions: 0 });
    // Rename + edit: oldPath carried, edit counted.
    const renamed = byPath.get("new-name.txt");
    expect(renamed?.oldPath).toBe("old-name.txt");
    expect(renamed).toMatchObject({ additions: 1, deletions: 0 });
    expect(byPath.get("script.sh")).toMatchObject({ additions: 0, deletions: 0 });
    expect(byPath.get("blob.dat")?.binary).toBe(true);
    // Body lines that collide with header prefixes stay body.
    const sql = byPath.get("comments.sql");
    expect(sql).toMatchObject({ additions: 1, deletions: 1 });
    expect(sql!.lines.some((line) => line.kind === "del" && line.text === "--- comment")).toBe(true);
    expect(sql!.lines.some((line) => line.kind === "add" && line.text === "+++ x")).toBe(true);
  });

  it("parses the diff package's createPatch output (Index/---/+++ without git headers)", () => {
    const created = createPatch("x.txt", "", "a\nb\n");
    const files = parsePatch(created);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "x.txt", additions: 2, deletions: 0 });

    const overwritten = createPatch("x.txt", "a\n", "c\n");
    const files2 = parsePatch(overwritten);
    expect(files2).toHaveLength(1);
    expect(files2[0]).toMatchObject({ path: "x.txt", additions: 1, deletions: 1 });
  });
});
