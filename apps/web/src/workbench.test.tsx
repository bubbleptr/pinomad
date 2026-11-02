import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Workbench } from "./App.tsx";
import { HostsContext } from "./entities/host/host-store.ts";
import {
  BACKGROUND_SUBAGENT_ID,
  fakeHosts,
  fakeRemote,
  fakeView,
  HOME_HOST,
  subagentConversation,
  withBackgroundSubagents,
} from "./test/story-fixtures.tsx";

describe("background subagent workbench", () => {
  it("shows the transcript without the composer or submission controls", () => {
    const view = withBackgroundSubagents(fakeView({ conversation: subagentConversation(BACKGROUND_SUBAGENT_ID) }));
    const hosts = {
      ...fakeHosts([HOME_HOST], HOME_HOST.hostKey),
      focus: { hostKey: HOME_HOST.hostKey, conversationId: BACKGROUND_SUBAGENT_ID },
    };
    render(
      <HostsContext.Provider value={hosts}>
        <Workbench remote={fakeRemote(view)} wsUrl="ws://test" hostKey={HOME_HOST.hostKey} framed={false} notify={false} />
      </HostsContext.Provider>,
    );

    expect(screen.getByText("Read-only · subagent")).toBeInTheDocument();
    expect(screen.queryByTestId("model-thinking-trigger")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText(/Write regression tests for parseList/)).toBeInTheDocument();
  });
});
