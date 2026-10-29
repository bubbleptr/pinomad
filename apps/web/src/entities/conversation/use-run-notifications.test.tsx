import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Organized } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary, DurableView } from "@pinomad/protocol/view.ts";
import { useRunNotifications } from "./use-run-notifications.ts";

class TestNotification {
  static permission: NotificationPermission = "granted";
  static instances: TestNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readonly title: string;
  readonly options?: NotificationOptions;
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    TestNotification.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

const id = (n: number): ConversationId => n as ConversationId;

const node = (over: Partial<ConversationSummary> = {}, children: readonly ConversationNode[] = []): ConversationNode => ({
  summary: { id: id(1), kind: "conversation", title: "Build it", ...over },
  children,
});

const organized = (...chats: ConversationNode[]): Organized => ({ chats, projects: [], archived: [] });

const view = (organized: Organized, connection: DurableView["connection"] = "connected"): DurableView =>
  ({ organized, connection }) as DurableView;

const hostA = "host-a";
const hostB = "host-b";

const running = view(organized(node({ status: "running" })));
const idle = view(organized(node()));

beforeEach(() => {
  TestNotification.instances = [];
  TestNotification.permission = "granted";
  vi.stubGlobal("Notification", TestNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRunNotifications", () => {
  it("notifies when a run finishes while the window is unfocused", () => {
    const open = vi.fn();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostA, undefined, open),
      { initialProps: { view: running } },
    );
    expect(TestNotification.instances).toHaveLength(0);

    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(1);
    const notification = TestNotification.instances[0]!;
    expect(notification.title).toBe("Build it");
    expect(notification.options).toMatchObject({
      body: "Finished",
      tag: "pinomad-conversation-host-a-1",
    });
  });

  it("suppresses only the conversation currently on screen", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ view, visible }) => useRunNotifications(view, hostA, visible, open),
      { initialProps: { view: running, visible: id(1) } },
    );
    rerender({ view: idle, visible: id(1) });
    expect(TestNotification.instances).toHaveLength(0);
  });

  it("notifies for a run finishing in another conversation while the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ view, visible }) => useRunNotifications(view, hostA, visible, open),
      { initialProps: { view: running, visible: id(2) } },
    );
    rerender({ view: idle, visible: id(2) });
    expect(TestNotification.instances).toHaveLength(1);
  });

  it("notifies for another host's same conversation id", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostB, undefined, open),
      { initialProps: { view: running } },
    );
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0]!.options).toMatchObject({
      tag: "pinomad-conversation-host-b-1",
    });
  });

  it("keeps its baseline while the focused conversation changes", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ view, visible }) => useRunNotifications(view, hostA, visible, open),
      { initialProps: { view: running, visible: id(1) as ConversationId | undefined } },
    );
    // Focus moved to another host, then back — the hook itself stayed mounted.
    rerender({ view: running, visible: undefined });
    rerender({ view: idle, visible: undefined });
    expect(TestNotification.instances).toHaveLength(1);
  });

  it("does nothing without permission", () => {
    TestNotification.permission = "denied";
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostA, undefined, vi.fn()),
      { initialProps: { view: running } },
    );
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(0);
  });

  it("clicking the notification focuses the window, opens the ref and closes it", () => {
    const open = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostA, undefined, open),
      { initialProps: { view: running } },
    );
    rerender({ view: idle });

    const notification = TestNotification.instances[0]!;
    notification.onclick!();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ hostKey: hostA, conversationId: id(1) });
    expect(notification.closed).toBe(true);
  });

  it("keeps the baseline while disconnected and reports the missed finish on reconnect", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostA, undefined, vi.fn()),
      { initialProps: { view: running } },
    );
    rerender({ view: view(idle.organized, "reconnecting") });
    expect(TestNotification.instances).toHaveLength(0);

    rerender({ view: view(running.organized, "connected") });
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0]!.options).toMatchObject({ body: "Finished" });
  });

  it("closes the waiting notification once the question is answered", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(
      ({ view }) => useRunNotifications(view, hostA, id(1), vi.fn()),
      { initialProps: { view: running } },
    );
    rerender({ view: view(organized(node({ status: "needs-answer" }))) });
    expect(TestNotification.instances).toHaveLength(1);
    const waiting = TestNotification.instances[0]!;
    expect(waiting.options).toMatchObject({ body: "Waiting for your answer" });

    // The user answers in the now-focused window: the run resumes and ends,
    // neither state reaching the notification area — the stale one must go.
    hasFocus.mockReturnValue(true);
    rerender({ view: view(organized(node({ status: "running" }))) });
    rerender({ view: view(organized(node())) });
    expect(waiting.closed).toBe(true);
    expect(TestNotification.instances).toHaveLength(1);
  });
});
