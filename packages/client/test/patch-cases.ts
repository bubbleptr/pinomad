// Named `parsePatch` inputs for the Rust comparison vectors — each case's
// expected output is the committed fixture, replayed field-for-field by
// pinomad-core. Keep the patches literal and deterministic (no shelling out
// to git) so both sides parse byte-identical input.

export interface PatchCase {
  readonly name: string;
  readonly patch: string;
}

/**
 * `diff` 8.x `createPatch` output, captured verbatim — the package itself is a
 * web devDependency, so these literals carry its `Index:`/`====`/`---`/`+++`
 * header shape (no `diff --git`) into the vectors.
 */
export const CREATE_PATCH_CASES: readonly PatchCase[] = [
  {
    name: "createPatch-created",
    patch: "Index: x.txt\n===================================================================\n--- x.txt\n+++ x.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n",
  },
  {
    name: "createPatch-overwritten",
    patch: "Index: x.txt\n===================================================================\n--- x.txt\n+++ x.txt\n@@ -1,1 +1,1 @@\n-a\n+c\n",
  },
];

export const PATCH_CASES: readonly PatchCase[] = [
  {
    name: "modified",
    patch: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  },
  {
    name: "new-file",
    patch: [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+fresh",
      "+lines",
      "",
    ].join("\n"),
  },
  {
    name: "deleted",
    patch: [
      "diff --git a/doomed.txt b/doomed.txt",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/doomed.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n"),
  },
  {
    name: "rename-with-edit",
    patch: [
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 66%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      "index 4444444..5555555 100644",
      "--- a/old-name.txt",
      "+++ b/new-name.txt",
      "@@ -1,2 +1,3 @@",
      " rename me",
      " keep",
      "+edited",
      "",
    ].join("\n"),
  },
  {
    name: "binary",
    patch: [
      "diff --git a/blob.dat b/blob.dat",
      "index 6666666..7777777 100644",
      "Binary files a/blob.dat and b/blob.dat differ",
      "",
    ].join("\n"),
  },
  {
    name: "git-binary-patch",
    patch: [
      "diff --git a/blob.dat b/blob.dat",
      "new file mode 100644",
      "index 0000000..8888888",
      "GIT binary patch",
      "literal 6",
      "bcmbtWI%(P+0RR91",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n"),
  },
  {
    name: "no-newline",
    patch: [
      "diff --git a/eof.txt b/eof.txt",
      "index 1111111..2222222 100644",
      "--- a/eof.txt",
      "+++ b/eof.txt",
      "@@ -1 +1 @@",
      "-tail",
      "\\ No newline at end of file",
      "+tail!",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  },
  { name: "empty", patch: "" },
  {
    name: "multi-file",
    patch: [
      "diff --git a/one.txt b/one.txt",
      "index 1111111..2222222 100644",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.txt b/two.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/two.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n"),
  },
  {
    // Body lines that collide with header prefixes must stay body: the hunk
    // counts, not the prefix, decide where the hunk ends.
    name: "header-collision-in-hunk",
    patch: [
      "diff --git a/comments.sql b/comments.sql",
      "index 1111111..2222222 100644",
      "--- a/comments.sql",
      "+++ b/comments.sql",
      "@@ -1,3 +1,3 @@",
      " SELECT 1",
      "--- comment",
      "+++ x",
      " SELECT 2",
      "",
    ].join("\n"),
  },
  ...CREATE_PATCH_CASES,
  {
    // The host cuts the patch at a line boundary (1 MiB cap) — a hunk can
    // end mid-run, and the trailing file's counts stay short.
    name: "truncated-mid-hunk",
    patch: [
      "diff --git a/big.txt b/big.txt",
      "index 1111111..2222222 100644",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,8 +1,8 @@",
      " ctx",
      "-old",
      "+new",
      "",
    ].join("\n"),
  },
];
