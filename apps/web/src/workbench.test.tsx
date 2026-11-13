import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Workbench } from "./App.tsx";
import { HostsContext } from "./entities/host/host-store.ts";
import {
  BACKGROUND_SUBAGENT_ID,
  fakeHosts,
  fakeRemote,
  fakeView,
  HOME_HOST,
  SUBAGENT_ID,
  subagentConversation,
  withBackgroundSubagents,
  withSummary,
} from "./test/story-fixtures.tsx";

function renderWorkbench(view: DurableView, conversationId: ConversationId) {
  const remote = fakeRemote(view);
  const hosts = {
    ...fakeHosts([HOME_HOST], HOME_HOST.hostKey),
    focus: { hostKey: HOME_HOST.hostKey, conversationId },
  };
  render(
    <HostsContext.Provider value={hosts}>
      <Workbench remote={remote} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
    </HostsContext.Provider>,
  );
  return remote;
}

const promptInput = () => document.querySelector('[data-slot="prompt-input"]');

const backgroundSubagent = (overrides: Partial<DurableView> = {}): DurableView =>
  withBackgroundSubagents(fakeView({ conversation: subagentConversation(BACKGROUND_SUBAGENT_ID), ...overrides }));

describe("subagent workbench (ADR-0047 §2)", () => {
  it("shows a subagent read-only, with no composer and no model control", () => {
    const view = withSummary(backgroundSubagent(), BACKGROUND_SUBAGENT_ID, { name: "socket-owner", status: undefined });
    renderWorkbench(view, BACKGROUND_SUBAGENT_ID);

    expect(screen.getByText("Read-only · subagent")).toBeInTheDocument();
    expect(screen.getAllByText("socket-owner").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("model-trigger")).toBeNull();
    expect(promptInput()).toBeNull();
    // Idle: nothing to stop.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText(/Write regression tests for parseList/)).toBeInTheDocument();
  });

  it("stops a named subagent at work, background or still in its call", () => {
    // The fixture's background subagent is running.
    const background = withSummary(backgroundSubagent(), BACKGROUND_SUBAGENT_ID, { name: "socket-owner" });
    const remote = renderWorkbench(background, BACKGROUND_SUBAGENT_ID);
    expect(promptInput()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    // The shown subagent by id, not whatever the controller still has current.
    expect(remote.controller.abort).toHaveBeenCalledWith(BACKGROUND_SUBAGENT_ID);
    cleanup();

    const foreground = withSummary(fakeView({ conversation: subagentConversation(SUBAGENT_ID) }), SUBAGENT_ID, { name: "parser-tests" });
    const inCall = renderWorkbench(foreground, SUBAGENT_ID);
    expect(promptInput()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(inCall.controller.abort).toHaveBeenCalledWith(SUBAGENT_ID);
  });

  it("offers no Stop on a host without it, or for a subagent from before names", () => {
    const older = backgroundSubagent({ host: { version: "0.9.0", protocol: { major: 5, minor: 32 } } });
    renderWorkbench(withSummary(older, BACKGROUND_SUBAGENT_ID, { name: "socket-owner" }), BACKGROUND_SUBAGENT_ID);
    expect(screen.getByText("Read-only · subagent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    cleanup();

    renderWorkbench(backgroundSubagent(), BACKGROUND_SUBAGENT_ID);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
