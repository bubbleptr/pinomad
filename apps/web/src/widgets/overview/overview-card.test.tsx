// jsdom: the overview card's Workspace branch row — a 5.11 host's
// changes() answer owns it, an older host's checkout record does.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CallMethods } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { OverviewCard } from "./overview-card.tsx";

type ChangesResult = CallMethods["changes"]["result"];

function renderCard(minor: number, result: ChangesResult, checkoutBranch?: string) {
  const changes = vi.fn(async () => result);
  const remote = { controller: { changes } } as unknown as RemoteDurable;
  const conversation = {
    conversation: { id: 1, kind: "conversation" },
    docs: { "pi.agent": { cwd: "/repo" } },
    entries: [],
  } as unknown as NonNullable<DurableView["conversation"]>;
  const view = {
    connection: "connected",
    conversation,
    home: { kind: "project", path: "/repo" },
    checkout:
      checkoutBranch === undefined
        ? undefined
        : { conversationId: 1, path: "/wt/1", repo: "/repo", subdir: "", branch: checkoutBranch, base: "c0ffee" },
    host: { protocol: { major: 5, minor } },
    organized: { chats: [], projects: [], archived: [] },
    docs: [],
    mcp: null,
  } as unknown as DurableView;
  render(
    <OverviewCard
      view={view}
      remote={remote}
      conversation={conversation}
      narrow={false}
      busy={false}
      onOpenChanges={() => {}}
      onOpenTasks={() => {}}
      onClose={() => {}}
    />,
  );
  return changes;
}

describe("OverviewCard workspace branch", () => {
  it("shows the branch changes() returns on a 5.11 host, even with no diff", async () => {
    // Unavailable still carries the branch (an unborn branch has no diff) —
    // and the Changes row hiding must not take the branch row with it.
    const changes = renderCard(
      11,
      { available: false, reason: "Not in a git repository", branch: "main" },
      "pinomad/1-dead",
    );
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(changes).toHaveBeenCalled();
    expect(screen.queryByText("pinomad/1-dead")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
  });

  it("hides the branch row when a 5.11 host omits it", async () => {
    // A worktree in detached HEAD sends no branch; the recorded name must
    // not come back as a fallback.
    renderCard(11, { available: true, base: "c0ffee", patch: "", truncated: false }, "pinomad/1-dead");
    // Wait for the fetch to land so "hidden" isn't just "still loading".
    expect(await screen.findByText("None")).toBeInTheDocument();
    expect(screen.queryByText("pinomad/1-dead")).not.toBeInTheDocument();
  });

  it("falls back to the recorded checkout branch on a pre-5.11 host", async () => {
    renderCard(10, { available: false, reason: "Not in a git repository" }, "pinomad/1-dead");
    expect(await screen.findByText("pinomad/1-dead")).toBeInTheDocument();
  });
});
