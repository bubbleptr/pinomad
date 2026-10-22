import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiffView } from "./diff.tsx";

const modified = [
  "diff --git a/src/tracked.ts b/src/tracked.ts",
  "index 1111111..2222222 100644",
  "--- a/src/tracked.ts",
  "+++ b/src/tracked.ts",
  "@@ -1,5 +1,6 @@",
  ' import { parse } from "./parse.ts";',
  " ",
  "-export function track(input: string) {",
  "-  return parse(input);",
  "+export function track(input: string, strict = false) {",
  "+  const result = parse(input);",
  "+  return strict ? result.orThrow() : result;",
  " }",
  "",
].join("\n");

const newFile = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,2 @@",
  "+fresh",
  "+lines",
  "",
].join("\n");

const deleted = [
  "diff --git a/doomed.txt b/doomed.txt",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/doomed.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "",
].join("\n");

const renamed = [
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
].join("\n");

const binary = [
  "diff --git a/blob.dat b/blob.dat",
  "index 6666666..7777777 100644",
  "Binary files a/blob.dat and b/blob.dat differ",
  "",
].join("\n");

const meta = {
  title: "Presentation/DiffView",
  component: DiffView,
  args: { patch: modified },
} satisfies Meta<typeof DiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Modified: Story = {};

export const SeveralFiles: Story = {
  args: { patch: [modified, newFile, deleted, renamed].join("") },
};

export const Binary: Story = {
  args: { patch: binary },
};

export const NoChanges: Story = {
  args: { patch: "" },
};
