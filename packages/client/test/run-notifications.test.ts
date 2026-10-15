import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationNode, Organized } from "@pinomad/protocol/organization.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { diffRunNotices, type StatusBaseline } from "../src/run-notifications.ts";

const id = (n: number): ConversationId => n as ConversationId;

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: id(1),
  kind: "conversation",
  title: "Build it",
  ...over,
});

const node = (over: Partial<ConversationSummary> = {}, children: readonly ConversationNode[] = []): ConversationNode => ({
  summary: summary(over),
  children,
});

const organized = (...chats: ConversationNode[]): Organized => ({ chats, projects: [], archived: [] });

const baseline = (entries: readonly [number, ConversationSummary["status"]][]): StatusBaseline =>
  new Map(entries.map(([n, status]) => [id(n), status]));

describe("diffRunNotices", () => {
  it("the first snapshot only seeds the baseline", () => {
    const { notices, baseline: next } = diffRunNotices(undefined, organized(node({ status: "needs-answer" })));
    expect(notices).toEqual([]);
    expect(next.get(id(1))).toBe("needs-answer");
  });

  it("running → idle is Finished", () => {
    const { notices } = diffRunNotices(baseline([[1, "running"]]), organized(node()));
    expect(notices).toEqual([{ id: id(1), title: "Build it", body: "Finished" }]);
  });

  it("running → failed is Failed", () => {
    const { notices } = diffRunNotices(baseline([[1, "running"]]), organized(node({ status: "failed" })));
    expect(notices).toEqual([{ id: id(1), title: "Build it", body: "Failed" }]);
  });

  it("running → needs-answer is Waiting", () => {
    const { notices } = diffRunNotices(baseline([[1, "running"]]), organized(node({ status: "needs-answer" })));
    expect(notices).toEqual([{ id: id(1), title: "Build it", body: "Waiting for your answer" }]);
  });

  it("needs-answer → running stays silent", () => {
    const { notices } = diffRunNotices(baseline([[1, "needs-answer"]]), organized(node({ status: "running" })));
    expect(notices).toEqual([]);
  });

  it("needs-answer → idle is Finished", () => {
    const { notices } = diffRunNotices(baseline([[1, "needs-answer"]]), organized(node()));
    expect(notices).toEqual([{ id: id(1), title: "Build it", body: "Finished" }]);
  });

  it("a subagent finishing stays silent", () => {
    const { notices } = diffRunNotices(
      baseline([[1, "running"], [2, "running"]]),
      organized(node({ status: "running" }, [node({ id: id(2), kind: "subagent" })])),
    );
    expect(notices).toEqual([]);
  });

  it("a subagent entering needs-answer notifies under its label", () => {
    const { notices } = diffRunNotices(
      baseline([[1, "running"], [2, "running"]]),
      organized(
        node({ status: "running" }, [
          node({ id: id(2), kind: "subagent", label: "Audit auth", status: "needs-answer" }),
        ]),
      ),
    );
    expect(notices).toEqual([{ id: id(2), title: "Audit auth", body: "Waiting for your answer" }]);
  });

  it("a new conversation appearing needs-answer notifies; appearing running does not", () => {
    const { notices } = diffRunNotices(
      baseline([[1, undefined]]),
      organized(node(), node({ id: id(2), status: "needs-answer" }), node({ id: id(3), status: "running" })),
    );
    expect(notices).toEqual([{ id: id(2), title: "Build it", body: "Waiting for your answer" }]);
  });

  it("a fork nested under its ancestor is watched too", () => {
    const { notices } = diffRunNotices(
      baseline([[1, "running"], [2, "running"]]),
      organized(node({ status: "running" }, [node({ id: id(2), kind: "fork" })])),
    );
    expect(notices).toEqual([{ id: id(2), title: "Build it", body: "Finished" }]);
  });

  it("a conversation gone from organized drops out of the baseline", () => {
    const { baseline: next } = diffRunNotices(baseline([[1, "running"], [2, "needs-answer"]]), organized(node()));
    expect(next.has(id(1))).toBe(true);
    expect(next.has(id(2))).toBe(false);
  });

  it("reports no changed ids on the first snapshot", () => {
    const { changed } = diffRunNotices(undefined, organized(node({ status: "needs-answer" })));
    expect(changed).toEqual([]);
  });

  it("reports exactly the ids whose status moved", () => {
    const { changed } = diffRunNotices(
      baseline([[1, "needs-answer"], [2, "running"], [3, undefined]]),
      organized(node({ status: "running" }), node({ id: id(2), status: "running" }), node({ id: id(3) })),
    );
    expect(changed).toEqual([id(1)]);
  });

  it("reports a conversation gone from organized as changed", () => {
    const { changed } = diffRunNotices(
      baseline([[1, "needs-answer"], [2, "running"]]),
      organized(node({ id: id(2), status: "running" })),
    );
    expect(changed).toEqual([id(1)]);
  });
});
