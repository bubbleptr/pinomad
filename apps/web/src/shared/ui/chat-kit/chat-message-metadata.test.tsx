// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessageMetadata.test.tsx (MIT).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessageMetadata } from "./chat-message-metadata";

describe("ChatMessageMetadata", () => {
  it("forwards rest props (data-*, aria-*, id) to the root element", () => {
    render(
      <ChatMessageMetadata
        timestamp="12:00"
        data-testid="meta"
        data-custom="x"
        id="meta-1"
      />,
    );
    const root = screen.getByTestId("meta");
    expect(root).toHaveAttribute("data-custom", "x");
    expect(root).toHaveAttribute("id", "meta-1");
  });
});
