import { fireEvent, render, screen } from "@testing-library/react";
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

describe("subagent workbench", () => {
  it("keeps a subagent from before names read-only", () => {
    renderWorkbench(backgroundSubagent(), BACKGROUND_SUBAGENT_ID);

    expect(screen.getByText("Read-only · subagent")).toBeInTheDocument();
    expect(screen.queryByTestId("model-thinking-trigger")).toBeNull();
    expect(promptInput()).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText(/Write regression tests for parseList/)).toBeInTheDocument();
  });

  it("keeps a named subagent read-only on a host without subagent messages", () => {
    const older = backgroundSubagent({ host: { version: "0.9.0", protocol: { major: 5, minor: 32 } } });
    renderWorkbench(withSummary(older, BACKGROUND_SUBAGENT_ID, { name: "socket-owner" }), BACKGROUND_SUBAGENT_ID);

    expect(screen.getByText("Read-only · subagent")).toBeInTheDocument();
    expect(promptInput()).toBeNull();
  });

  it("gives a named background subagent a composer and Stop, but not its model", () => {
    const view = withSummary(backgroundSubagent(), BACKGROUND_SUBAGENT_ID, { name: "socket-owner" });
    const remote = renderWorkbench(view, BACKGROUND_SUBAGENT_ID);

    expect(screen.queryByText("Read-only · subagent")).toBeNull();
    expect(screen.getAllByText("socket-owner").length).toBeGreaterThan(0);
    expect(promptInput()).not.toBeNull();
    expect(screen.getByTestId("model-thinking-trigger")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(remote.controller.abort).toHaveBeenCalled();
  });

  it("holds messages while a foreground subagent answers its call, but Stop works", () => {
    // The fixture's foreground subagent is running: still inside its call.
    const view = withSummary(fakeView({ conversation: subagentConversation(SUBAGENT_ID) }), SUBAGENT_ID, { name: "parser-tests" });
    const remote = renderWorkbench(view, SUBAGENT_ID);

    expect(promptInput()).toBeNull();
    expect(screen.getByText(/you can message it when it's done/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(remote.controller.abort).toHaveBeenCalled();
  });
});
