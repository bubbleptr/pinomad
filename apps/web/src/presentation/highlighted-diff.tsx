// A file's body in DiffView, syntax-highlighted by @pierre/diffs. Loaded
// lazily, so the highlighter and its grammars stay out of the main bundle;
// the caller's plain rendering shows while this loads and whenever Pierre
// can't place the file.
import {
  canUseWASM,
  getFiletypeFromFileName,
  parsePatchFiles,
  preloadHighlighter,
  type FileDiffMetadata,
  type SupportedLanguages,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { use, type ReactNode } from "react";

// Inside the diff's shadow root: the page's tokens for surface and type, so
// the diff sits on the panel like the rest of the app. Pierre's host pins
// `color-scheme: light dark`, so its light-dark() colors would follow the OS
// rather than the one the appearance setting forces; inherit the page's instead.
const SURFACE_CSS = [
  ":host{color-scheme:inherit;",
  "--diffs-light-bg:var(--surface);",
  "--diffs-dark-bg:var(--surface);",
  "--diffs-font-family:var(--font-family-code)}",
].join("");

const HIGHLIGHTER = canUseWASM() ? "highlights" : "shiki-js";

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
  preferredHighlighter: HIGHLIGHTER,
} as const;

type Files = ReadonlyMap<string, FileDiffMetadata>;

// Every open file of a patch asks for its own entry; parse each patch once.
// A few entries, so a tool-result diff in the chat and the Changes surface
// don't evict each other on every render.
const parsed = new Map<string, Files>();
const PARSED_KEEP = 4;

function filesOf(patch: string): Files {
  let files = parsed.get(patch);
  if (files === undefined) {
    files = byPath(parseFiles(patch));
    if (parsed.size >= PARSED_KEEP) parsed.delete(parsed.keys().next().value!);
    parsed.set(patch, files);
  }
  return files;
}

function parseFiles(patch: string): readonly FileDiffMetadata[] {
  try {
    return parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
  } catch {
    // A truncated Changes patch ends mid-hunk (the host cuts at a line); the
    // files before the cut are whole, the last one stays plain.
    try {
      return parsePatchFiles(patch, undefined, false)
        .flatMap((entry) => entry.files)
        .slice(0, -1);
    } catch {
      return [];
    }
  }
}

/**
 * Pierre's files by the paths parsePatch reads, which strips the a/ and b/
 * that Pierre keeps without a `diff --git` line. Exact names go in first, so
 * a stripped alias never takes the path of a real file (b/foo.ts vs foo.ts).
 */
function byPath(files: readonly FileDiffMetadata[]): Files {
  const map = new Map<string, FileDiffMetadata>();
  const add = (name: string | undefined, file: FileDiffMetadata) => {
    if (name !== undefined && !map.has(name)) map.set(name, file);
  };
  for (const file of files) {
    add(file.name, file);
    add(file.prevName, file);
  }
  for (const file of files) {
    add(file.name.replace(/^b\//, ""), file);
    add(file.prevName?.replace(/^a\//, ""), file);
  }
  return map;
}

// FileDiff must mount with its highlighter loaded. Mounted cold, it leaves an
// empty <pre> and draws once highlighting resolves; when React detaches and
// reattaches it before then (StrictMode in development, a Suspense boundary
// hiding shown content), the new instance takes that empty <pre> for
// prerendered markup and never draws. Warm, the first render is complete.
const loading = new Map<SupportedLanguages, Promise<void>>();

function highlighterFor(file: FileDiffMetadata): Promise<void> {
  const lang = file.lang ?? getFiletypeFromFileName(file.name);
  let load = loading.get(lang);
  if (load === undefined) {
    // A grammar that fails to load leaves FileDiff to show the file as plain text.
    load = preloadHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: [lang], preferredHighlighter: HIGHLIGHTER }).catch(
      () => undefined,
    );
    loading.set(lang, load);
  }
  return load;
}

export default function HighlightedFile({
  patch,
  path,
  fallback,
}: {
  patch: string;
  /** The file's path as `parsePatch` reads it. */
  path: string;
  /** Shown when Pierre has no file at that path. */
  fallback: ReactNode;
}) {
  const file = filesOf(patch).get(path);
  if (file === undefined) return fallback;
  // Suspends, so the caller's plain lines show until the grammar is in.
  use(highlighterFor(file));
  return <FileDiff fileDiff={file} options={OPTIONS} disableWorkerPool />;
}
