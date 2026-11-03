// The Terminal surface follows the terminals' owner: one owner's
// conversations share a list and a selection, and each owner's last tab is
// remembered. xterm itself is stubbed; the screen is just its terminal id.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteTerminals } from "@pinomad/protocol/remote-durable.ts";
import { fakeTerminals, TERMINALS } from "../../test/story-fixtures.tsx";
import { TerminalSurface } from "./terminal-surface.tsx";

vi.mock("./xterm-view.tsx", () => ({
  default: ({ terminalId }: { terminalId: string }) => <div data-testid="screen">{terminalId}</div>,
}));

const id = (n: number) => n as ConversationId;
const [dev, shell, tests] = TERMINALS as [(typeof TERMINALS)[number], (typeof TERMINALS)[number], (typeof TERMINALS)[number]];

function renderSurface(terminals: RemoteTerminals, conversationId: ConversationId) {
  const surface = (shown: ConversationId) => (
    <TerminalSurface terminals={terminals} conversationId={shown} connected stacked={false} />
  );
  const result = render(surface(conversationId));
  return { show: (shown: ConversationId) => result.rerender(surface(shown)) };
}

// Astryx tabs are buttons in a nav; the selected one is the current page.
const selectedTab = () => document.querySelector('nav [aria-current="page"]')?.getAttribute("data-tab-value");

describe("TerminalSurface", () => {
  it("keeps one owner's selection across its conversations and remembers each owner's", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev, shell], 7: [{ ...shell, id: "t-other", name: "other" }] }, owners: { 4: id(1) } });
    const { show } = renderSurface(terminals, id(1));
    fireEvent.click(screen.getByRole("button", { name: "Terminal 2" }));
    expect(await screen.findByTestId("screen")).toHaveTextContent("t-shell");

    show(id(4));
    expect(selectedTab()).toBe("t-shell");
    show(id(7));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-other"));
    show(id(1));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-shell"));
  });

  it("offers a first terminal when there is none, then selects it once the host lists it", async () => {
    const terminals = fakeTerminals({ lists: { 1: [] } });
    renderSurface(terminals, id(1));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-new-1"));
    expect(selectedTab()).toBe("t-new-1");
  });

  it("selects a new terminal beside existing ones, not the first tab", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev] } });
    renderSurface(terminals, id(1));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    await waitFor(() => expect(selectedTab()).toBe("t-new-1"));
  });

  it("disables New terminal once the owner has the host's limit", () => {
    renderSurface(fakeTerminals({ lists: { 1: [dev, shell] }, limit: 2 }), id(1));
    expect(screen.getByRole("button", { name: "New terminal" })).toHaveAttribute("aria-disabled", "true");
  });

  it("says why a host has no terminals", () => {
    renderSurface(fakeTerminals({ unavailable: "The host is too old for terminals" }), id(1));
    expect(screen.getByText("The host is too old for terminals")).toBeInTheDocument();
  });

  it("shows an exited terminal's code and restarts it", async () => {
    const terminals = fakeTerminals({ lists: { 1: [tests] } });
    renderSurface(terminals, id(1));
    expect(screen.getByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("The process exited with code 1.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(terminals.restart).toHaveBeenCalledWith("t-tests", { cols: 80, rows: 24 });
    await waitFor(() => expect(screen.queryByText("exit 1")).toBeNull());
  });
});
