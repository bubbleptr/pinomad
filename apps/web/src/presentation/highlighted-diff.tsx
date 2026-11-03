// A file's body in DiffView, syntax-highlighted by @pierre/diffs. Loaded
// lazily, so the highlighter and its grammars stay out of the main bundle;
// the caller's plain rendering shows while this loads and whenever Pierre
// can't place the file.
import { canUseWASM, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ReactNode } from "react";

// Inside the diff's shadow root: the page's tokens for surface and type, so
// the diff sits on the panel like the rest of the app. Pierre's host pins
// `color-scheme: light dark`, so its light-dark() colors would follow the OS
// rather than a scheme the Theme element forces; inherit the page's instead.
const SURFACE_CSS = [
  ":host{color-scheme:inherit;",
  "--diffs-light-bg:var(--color-background-surface);",
  "--diffs-dark-bg:var(--color-background-surface);",
  "--diffs-font-family:var(--font-family-code)}",
].join("");

const OPTIONS = {
  themeType: "system",
  diffStyle: "unified",
  overflow: "scroll",
  disableFileHeader: true,
  // A working-tree patch carries no file contents to expand the gaps from.
  hunkSeparators: "simple",
  unsafeCSS: SURFACE_CSS,
  // Highlights needs WebAssembly (and wasm-unsafe-eval in the CSP); without it,
  // Shiki's JS engine with the curated grammars in pierre/shiki-langs.ts.
  preferredHighlighter: canUseWASM() ? "highlights" : "shiki-js",
} as const;

// Every open file of a patch asks for its own entry; parse the patch once.
let parsed: { readonly patch: string; readonly files: readonly FileDiffMetadata[] | undefined } | undefined;

function filesOf(patch: string): readonly FileDiffMetadata[] | undefined {
  if (parsed?.patch !== patch) {
    let files: readonly FileDiffMetadata[] | undefined;
    try {
      files = parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
    } catch {
      files = undefined;
    }
    parsed = { patch, files };
  }
  return parsed.files;
}

export default function HighlightedFile({
  patch,
  index,
  path,
  fallback,
}: {
  patch: string;
  /** The file's position in the patch, as `parsePatch` counts it. */
  index: number;
  /** Its path as `parsePatch` reads it; a mismatch means the two parsers disagree. */
  path: string;
  fallback: ReactNode;
}) {
  const file = filesOf(patch)?.[index];
  // Without a `diff --git` line Pierre keeps the a/ and b/ prefixes that parsePatch strips.
  const names = [file?.name, file?.prevName, file?.name.replace(/^b\//, ""), file?.prevName?.replace(/^a\//, "")];
  if (file === undefined || !names.includes(path)) return fallback;
  return <FileDiff fileDiff={file} options={OPTIONS} disableWorkerPool />;
}
