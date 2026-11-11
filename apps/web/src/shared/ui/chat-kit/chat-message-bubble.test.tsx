// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatMessageBubble.test.tsx (MIT).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage } from "./chat-message";
import { ChatMessageBubble } from "./chat-message-bubble";
import { ChatMessageList } from "./chat-message-list";
import { ChatMessageMetadata } from "./chat-message-metadata";

describe("ChatMessageBubble", () => {
  it("reflects the sender from context", () => {
    render(
      <ChatMessage sender="user">
        <ChatMessageBubble data-testid="bubble">Hi</ChatMessageBubble>
      </ChatMessage>,
    );
    const el = screen.getByTestId("bubble");
    expect(el).toHaveAttribute("data-sender", "user");
  });

  it("defaults to assistant when no context", () => {
    render(
      <ChatMessageBubble data-testid="bubble">
        Standalone
      </ChatMessageBubble>,
    );
    const el = screen.getByTestId("bubble");
    expect(el).toHaveAttribute("data-sender", "assistant");
  });

  it("reflects the inherited compact density", () => {
    render(
      <ChatMessageList density="compact">
        <ChatMessage sender="assistant">
          <ChatMessageBubble data-testid="bubble">
            Compact
          </ChatMessageBubble>
        </ChatMessage>
      </ChatMessageList>,
    );
    const el = screen.getByTestId("bubble");
    expect(el).toHaveAttribute("data-density", "compact");
  });
});

describe("ChatMessageMetadata", () => {
  it("renders timestamp", () => {
    render(
      <ChatMessage sender="assistant">
        <ChatMessageMetadata timestamp="2:30 PM" />
      </ChatMessage>,
    );
    expect(screen.getByText("2:30 PM")).toBeTruthy();
  });

  it("renders footer content", () => {
    render(
      <ChatMessage sender="assistant">
        <ChatMessageMetadata footer={<span>Liked</span>} />
      </ChatMessage>,
    );
    expect(screen.getByText("Liked")).toBeTruthy();
  });

  it("renders status", () => {
    render(
      <ChatMessage sender="user">
        <ChatMessageMetadata status="sent" />
      </ChatMessage>,
    );
    expect(screen.getByLabelText("Message sent")).toBeTruthy();
  });

  it("renders timestamp and status on one row", () => {
    render(
      <ChatMessage sender="user">
        <ChatMessageMetadata timestamp="2:30 PM" status="read" />
      </ChatMessage>,
    );
    expect(screen.getByText("2:30 PM")).toBeTruthy();
    expect(screen.getByLabelText("Message read")).toBeTruthy();
    expect(screen.getByText("·")).toBeTruthy();
  });

  it("renders nothing when all props are empty", () => {
    const {container} = render(
      <ChatMessage sender="user">
        <ChatMessageMetadata />
      </ChatMessage>,
    );
    // Only the article wrapper from ChatMessage
    expect(container.querySelectorAll("article").length).toBe(1);
  });
});
