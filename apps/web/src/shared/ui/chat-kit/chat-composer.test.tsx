// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatComposer.test.tsx (MIT).

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { ChatComposer } from "./chat-composer";
import { useChatComposerContext } from "./chat-context";

// A custom input that participates in the composer's composition contract:
// reads value/submit from the exported context, and registers a focus control
// so the shell can drive body-click-to-focus without knowing its DOM shape.
function CustomContextInput({focusSpy}: {focusSpy: () => void}) {
  const ctx = useChatComposerContext();
  const ref = useRef<HTMLInputElement>(null);
  const controlRef = ctx?.inputControlRef;
  useEffect(() => {
    if (!controlRef) {
      return;
    }
    controlRef.current = {
      focus: () => {
        focusSpy();
        ref.current?.focus();
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, focusSpy]);
  return (
    <input
      ref={ref}
      data-testid="custom-input"
      value={ctx?.value ?? ""}
      placeholder={ctx?.placeholder}
      disabled={ctx?.isDisabled}
      onChange={e => ctx?.onChange(e.target.value)}
    />
  );
}

describe("ChatComposer input composition contract", () => {
  it("exposes value/onChange/placeholder/isDisabled to a custom input via context", () => {
    const {getByTestId} = render(
      <ChatComposer
        onSubmit={() => {}}
        value="hello"
        placeholder="Say something"
        isDisabled
        input={<CustomContextInput focusSpy={() => {}} />}
      />,
    );
    const input = getByTestId("custom-input") as HTMLInputElement;
    expect(input.value).toBe("hello");
    expect(input.placeholder).toBe("Say something");
    expect(input.disabled).toBe(true);
  });

  it("focuses a custom input via its registered control on body click", () => {
    const focusSpy = vi.fn();
    const {getByTestId} = render(
      <ChatComposer
        onSubmit={() => {}}
        input={<CustomContextInput focusSpy={focusSpy} />}
      />,
    );
    const marker = getByTestId("custom-input");
    const body = marker.parentElement!.parentElement!;
    fireEvent.click(body);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("falls back to focusing a bare textarea when no control is registered", () => {
    const {getByTestId} = render(
      <ChatComposer
        onSubmit={() => {}}
        input={<textarea data-testid="bare-textarea" />}
      />,
    );
    const textarea = getByTestId("bare-textarea") as HTMLTextAreaElement;
    const body = textarea.parentElement!.parentElement!;
    fireEvent.click(body);
    expect(document.activeElement).toBe(textarea);
  });
});
