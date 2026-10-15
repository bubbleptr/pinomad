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

// A conversation whose run just ended: the first render's baseline says
// running, the rerender's snapshot says idle.
const useNotifications = (open: (id: ConversationId) => void) => {
  const running = view(organized(node({ status: "running" })));
  const idle = view(organized(node()));
  const hook = renderHook(({ view }) => useRunNotifications(view, open), { initialProps: { view: running } });
  return { ...hook, running, idle };
};

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
    const { rerender, idle } = useNotifications(open);
    expect(TestNotification.instances).toHaveLength(0);

    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(1);
    const notification = TestNotification.instances[0]!;
    expect(notification.title).toBe("Build it");
    expect(notification.options).toMatchObject({ body: "Finished", tag: "pinomad-conversation-1" });
  });

  it("stays silent while the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { rerender, idle } = useNotifications(vi.fn());
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(0);
  });

  it("does nothing without permission", () => {
    TestNotification.permission = "denied";
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender, idle } = useNotifications(vi.fn());
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(0);
  });

  it("clicking the notification focuses the window, opens the conversation and closes it", () => {
    const open = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender, idle } = useNotifications(open);
    rerender({ view: idle });

    const notification = TestNotification.instances[0]!;
    notification.onclick!();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(id(1));
    expect(notification.closed).toBe(true);
  });

  it("keeps the baseline while disconnected and reports the missed finish on reconnect", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender, running, idle } = useNotifications(vi.fn());
    rerender({ view: view(idle.organized, "reconnecting") });
    expect(TestNotification.instances).toHaveLength(0);

    rerender({ view: view(running.organized, "connected") });
    rerender({ view: idle });
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0]!.options).toMatchObject({ body: "Finished" });
  });

  it("closes the waiting notification once the question is answered", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook(({ view }) => useRunNotifications(view, vi.fn()), {
      initialProps: { view: view(organized(node({ status: "running" }))) },
    });
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
