// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/hooks/useStreamingText.test.ts), MIT.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useStreamingText} from './use-streaming-text';

describe('useStreamingText', () => {
  let rafCallbacks: ((time: number) => void)[];
  let originalRAF: typeof requestAnimationFrame;
  let originalCAF: typeof cancelAnimationFrame;
  let originalMatchMedia: typeof window.matchMedia | undefined;
  // Toggled per-test to drive the reduced-motion media query. Reset in
  // beforeEach so the preference never leaks between tests.
  let prefersReducedMotion: boolean;

  beforeEach(() => {
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn(cb => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    globalThis.cancelAnimationFrame = vi.fn();

    // Mock matchMedia for the hook's reduced-motion read.
    prefersReducedMotion = false;
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion')
          ? prefersReducedMotion
          : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    // Restore matchMedia so the mock never leaks into other suites. jsdom
    // has no matchMedia by default, so drop the property when there was none.
    if (originalMatchMedia === undefined) {
      // @ts-expect-error jsdom leaves matchMedia undefined by default
      delete window.matchMedia;
    } else {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('returns full text when not streaming', () => {
    const {result} = renderHook(() => useStreamingText('Hello world', false));
    expect(result.current).toBe('Hello world');
  });

  it('snaps to full text immediately when reduced motion is preferred', () => {
    prefersReducedMotion = true;
    const {result} = renderHook(() => useStreamingText('Hello world', true));
    expect(result.current).toBe('Hello world');
  });

  it('keeps snapping to the full text on updates when reduced motion is preferred', () => {
    prefersReducedMotion = true;
    const {result, rerender} = renderHook(
      ({text}) => useStreamingText(text, true),
      {initialProps: {text: 'Hello'}},
    );

    expect(result.current).toBe('Hello');

    // A later chunk arrives — it should appear in full, not reveal char-by-char.
    rerender({text: 'Hello world'});
    expect(result.current).toBe('Hello world');
  });

  it('snaps to full text when streaming ends', () => {
    const {result, rerender} = renderHook(
      ({text, streaming}) => useStreamingText(text, streaming),
      {initialProps: {text: 'Hello world', streaming: true}},
    );

    expect(result.current).toBe('');

    // Stop streaming
    rerender({text: 'Hello world', streaming: false});
    expect(result.current).toBe('Hello world');
  });

  it('resets when target text clears', () => {
    const {result, rerender} = renderHook(
      ({text, streaming}) => useStreamingText(text, streaming),
      {initialProps: {text: 'Hello', streaming: false}},
    );

    expect(result.current).toBe('Hello');

    // Clear text (new message)
    rerender({text: '', streaming: true});
    expect(result.current).toBe('');
  });

  it('advances monotonically without stalls or backwards jumps', () => {
    const targetText =
      'Hello **world**, this is `code` and [a link](http://example.com).';
    const {result} = renderHook(() => useStreamingText(targetText, true));

    expect(result.current).toBe('');

    // Fire many animation frames — the revealed length should only increase
    const lengths: number[] = [0];
    for (let i = 0; i < 50; i++) {
      if (rafCallbacks.length > 0) {
        const cb = rafCallbacks.pop()!;
        act(() => cb(performance.now() + i * 20));
      }
      const len = result.current.length;
      expect(len).toBeGreaterThanOrEqual(lengths[lengths.length - 1]);
      lengths.push(len);
    }

    // Should have made progress (not stuck at 0)
    expect(lengths[lengths.length - 1]).toBeGreaterThan(0);

    // Should never have gone backwards
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
  });

  it('does not stall on markdown syntax characters', () => {
    // Text with lots of markdown syntax that previously caused stalls
    const targetText =
      '- **bold** and *italic* with `code` and [link](url) and ~~strike~~';
    const {result} = renderHook(() => useStreamingText(targetText, true));

    // Fire enough frames to drain the entire text
    for (let i = 0; i < 100; i++) {
      if (rafCallbacks.length > 0) {
        const cb = rafCallbacks.pop()!;
        act(() => cb(performance.now() + i * 60));
      }
    }

    // With enough frames and time elapsed, should have revealed everything
    // (or close to it — the hook drains charsPerTick per tickMs)
    expect(result.current.length).toBeGreaterThan(targetText.length * 0.5);
  });
});
