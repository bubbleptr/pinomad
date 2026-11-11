// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/chatComposerSelection.ts (MIT).

/**
 * Ensure the current Selection has a Range inside `editable`.
 *
 * If `window.getSelection()` already has a Range whose `startContainer`
 * is inside `editable`, this is a no-op. Otherwise a collapsed caret
 * is placed at the end of `editable` and the Selection is updated.
 *
 * Returns the live `Selection` on success, or `null` if no Selection
 * is available at all (e.g. detached document, JSDOM without selection
 * support).
 */
export function ensureCaretInside(editable: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection) {
    return null;
  }

  if (selection.rangeCount > 0) {
    const existing = selection.getRangeAt(0);
    if (editable.contains(existing.startContainer)) {
      return selection;
    }
  }

  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false); // collapse to end
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

/**
 * Insert plain text at the current selection, scoped to `editable`.
 *
 * Ensures a caret exists inside `editable` first (see `ensureCaretInside`)
 * so callers don't have to manage Selection state to make insertion work
 * — e.g. after a programmatic focus that didn't create a Range.
 *
 * Returns `true` if text was inserted, `false` only if the Selection
 * API is unavailable.
 */
export function insertTextAtCursor(
  editable: HTMLElement,
  text: string,
): boolean {
  const selection = ensureCaretInside(editable);
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
