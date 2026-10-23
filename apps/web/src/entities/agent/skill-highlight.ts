// The composer's bound `$name` highlights (issues #143, #308): CSS Custom
// Highlight API — ranges over the contentEditable's text nodes painted via
// `::highlight`, so the DOM Astryx owns is never mutated. Only the ranges a
// `$` menu pick bound are painted (skill-bindings.ts); a typed `$name` stays
// plain. One registry entry holds every editable's ranges; each caller swaps
// only its own. Browsers without the API simply show no highlight.
import type { MentionRange } from "@pinomad/client/skill-mentions.ts";

/** The HighlightRegistry name — `chat.css` paints `::highlight(pinomad-skill-mention)`. */
export const SKILL_HIGHLIGHT_NAME = "pinomad-skill-mention";

const supported = (): boolean =>
  typeof CSS !== "undefined" && typeof Highlight === "function" && "highlights" in CSS;

let shared: Highlight | undefined;
const sharedHighlight = (): Highlight => {
  shared ??= new Highlight();
  // Idempotent — registry entries survive callers unmounting mid-flight.
  CSS.highlights.set(SKILL_HIGHLIGHT_NAME, shared);
  return shared;
};

interface TextSegment {
  readonly node?: Text;
  /** UTF-16 offsets this segment covers, in serialize() order. */
  readonly start: number;
  readonly end: number;
}

/**
 * Walk the editable the way Astryx's `serialize` reads it: a text node
 * carries its content, a BR one `\n`, a `data-astryx-token` element its token
 * value, and other elements recurse. Mention ranges that land on non-text
 * segments can't anchor a Range — names are plain text in practice, so this
 * only guards against foreign content.
 */
function textSegments(root: HTMLElement): TextSegment[] {
  const segments: TextSegment[] = [];
  let offset = 0;
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child as Text).data.length;
        segments.push({ node: child as Text, start: offset, end: offset + length });
        offset += length;
      } else if (child instanceof HTMLElement) {
        if (child.hasAttribute("data-astryx-token")) {
          const length = child.getAttribute("data-astryx-token-value")?.length ?? 0;
          segments.push({ start: offset, end: offset + length });
          offset += length;
        } else if (child.tagName === "BR") {
          segments.push({ start: offset, end: offset + 1 });
          offset += 1;
        } else {
          walk(child);
        }
      }
    }
  };
  walk(root);
  return segments;
}

/** The DOM Ranges for the value's `mentions` (UTF-16 offsets) inside `editable`. */
export function mentionDomRanges(editable: HTMLElement, mentions: readonly MentionRange[]): Range[] {
  if (mentions.length === 0) return [];
  const segments = textSegments(editable);
  const ranges: Range[] = [];
  for (const { start, end } of mentions) {
    const first = segments.find((segment) => segment.node !== undefined && segment.start <= start && start < segment.end);
    const last = segments.find((segment) => segment.node !== undefined && segment.start < end && end <= segment.end);
    if (first?.node === undefined || last?.node === undefined) continue;
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Paint the value's `mentions` inside `editable`; returns the cleanup
 * removing exactly these ranges from the shared registry entry.
 */
export function applySkillHighlights(editable: HTMLElement, mentions: readonly MentionRange[]): () => void {
  if (!supported()) return () => {};
  const ranges = mentionDomRanges(editable, mentions);
  if (ranges.length === 0) return () => {};
  const highlight = sharedHighlight();
  for (const range of ranges) highlight.add(range);
  return () => {
    for (const range of ranges) highlight.delete(range);
  };
}
