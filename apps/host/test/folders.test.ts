import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFolders } from "../src/folders.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

describe("listFolders", () => {
  it("lists visible subdirectories in natural, case-insensitive order", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    for (const name of ["b", "A", "a10", "a2", ".hidden"]) await mkdir(join(dir.path, name));
    await writeFile(join(dir.path, "a-file"), "x");
    await symlink(join(dir.path, "a-file"), join(dir.path, "file-link"));
    await symlink(join(dir.path, "b"), join(dir.path, "dir-link"));
    await symlink(join(dir.path, "gone"), join(dir.path, "broken-link"));

    const home = join(dir.path, "home");
    const listing = await listFolders(dir.path, home);
    const real = await realpath(dir.path);
    expect(listing.path).toBe(real);
    expect(listing.home).toBe(home);
    expect(listing.folders).toEqual([
      { name: "A", path: join(real, "A") },
      { name: "a2", path: join(real, "a2") },
      { name: "a10", path: join(real, "a10") },
      { name: "b", path: join(real, "b") },
      { name: "dir-link", path: join(real, "dir-link") },
    ]);
  });

  it("lists the injected home when path is undefined, with home resolved like path", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "sub"));
    await symlink(dir.path, join(dir.path, "sub", "home-link"));

    const listing = await listFolders(undefined, join(dir.path, "sub", "home-link"));
    const real = await realpath(dir.path);
    expect(listing.path).toBe(real);
    expect(listing.home).toBe(real);
    expect(listing.folders).toEqual([{ name: "sub", path: join(real, "sub") }]);
  });

  it("normalizes the listed path with realpath", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    await mkdir(join(dir.path, "sub"));
    const real = await realpath(dir.path);
    await symlink(join(dir.path, "sub"), join(dir.path, "link"));

    const dotted = await listFolders(join(dir.path, "sub", ".."), "home");
    expect(dotted.path).toBe(real);
    const linked = await listFolders(join(dir.path, "link"), "home");
    expect(linked.path).toBe(join(real, "sub"));
  });

  it("rejects relative, missing, non-directory, and unreadable paths with the given path", async () => {
    const dir = await tempDir();
    defer(dir.remove);
    const file = join(dir.path, "a-file");
    await writeFile(file, "x");

    await expect(listFolders("relative/path", "home")).rejects.toThrow("relative/path");
    await expect(listFolders(join(dir.path, "does-not-exist"), "home")).rejects.toThrow("does-not-exist");
    await expect(listFolders(file, "home")).rejects.toThrow("a-file");

    // chmod 000 makes readdir fail with EACCES — except for root, which reads anyway.
    if (process.getuid?.() !== 0) {
      const locked = join(dir.path, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      await expect(listFolders(locked, "home")).rejects.toThrow("locked");
    }
  });
});
