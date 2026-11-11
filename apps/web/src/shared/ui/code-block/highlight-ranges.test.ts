// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/CodeBlock/highlightRanges.test.ts), MIT.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {applyHighlightRangesChunked} from './highlight-ranges';
import type {TokenLine} from './tokenizer';

// Mock CSS Highlight API
class MockHighlight extends Set<Range> {}
const mockHighlightsMap = new Map<string, MockHighlight>();

beforeEach(() => {
  mockHighlightsMap.clear();

  globalThis.CSS = {
    highlights: {
      get: (name: string) => mockHighlightsMap.get(name),
      set: (name: string, h: MockHighlight) => mockHighlightsMap.set(name, h),
    } as unknown as HighlightRegistry,
  } as typeof CSS;

  // @ts-expect-error - mocking global Highlight
  globalThis.Highlight = MockHighlight;

  // Mock requestAnimationFrame
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createCodeElement(lines: string[]): HTMLElement {
  const code = document.createElement('code');
  for (let i = 0; i < lines.length; i++) {
    const div = document.createElement('div');
    div.setAttribute('data-line', String(i + 1));
    div.textContent = lines[i] || '\u200b';
    code.appendChild(div);
  }
  return code;
}

describe('applyHighlightRangesChunked', () => {
  it('creates ranges for tokens on each line', () => {
    const codeEl = createCodeElement(['const x = 1;', 'let y = 2;']);
    const tokenLines: TokenLine[] = [
      [{type: 'keyword', start: 0, end: 5}], // "const"
      [{type: 'keyword', start: 0, end: 3}], // "let"
    ];


    const cleanup = applyHighlightRangesChunked(codeEl, tokenLines);

    const kwHighlight = mockHighlightsMap.get('pinomad-keyword');
    expect(kwHighlight).toBeDefined();
    expect(kwHighlight!.size).toBe(2);

    cleanup();
    expect(kwHighlight!.size).toBe(0);
  });

  it('handles empty token lines', () => {
    const codeEl = createCodeElement(['', 'const x = 1;']);
    const tokenLines: TokenLine[] = [[], [{type: 'keyword', start: 0, end: 5}]];


    const cleanup = applyHighlightRangesChunked(codeEl, tokenLines);

    const kwHighlight = mockHighlightsMap.get('pinomad-keyword');
    expect(kwHighlight).toBeDefined();
    expect(kwHighlight!.size).toBe(1);

    cleanup();
  });

  it('returns cleanup that removes all ranges', () => {
    const codeEl = createCodeElement(['const x = 1;']);
    const tokenLines: TokenLine[] = [
      [
        {type: 'keyword', start: 0, end: 5},
        {type: 'number', start: 10, end: 11},
      ],
    ];


    const cleanup = applyHighlightRangesChunked(codeEl, tokenLines);

    const kwHighlight = mockHighlightsMap.get('pinomad-keyword');
    const numHighlight = mockHighlightsMap.get('pinomad-number');
    expect(kwHighlight!.size).toBe(1);
    expect(numHighlight!.size).toBe(1);

    cleanup();
    expect(kwHighlight!.size).toBe(0);
    expect(numHighlight!.size).toBe(0);
  });
});
