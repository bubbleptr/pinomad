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
  default: ({ terminalId, enabled }: { terminalId: string; enabled: boolean }) => (
    <div data-testid="screen" data-enabled={enabled}>
      {terminalId}
    </div>
  ),
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

// Terminal tabs are buttons in a nav; the selected one is the current page.
const selectedTab = () => document.querySelector('nav [aria-current="page"]')?.getAttribute("data-tab-value");

describe("TerminalSurface", () => {
  it("keeps one owner's selection across its conversations and remembers each owner's", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev, shell], 7: [{ ...shell, id: "t-other", name: "other" }] }, owners: { 4: id(1) } });
    const { show } = renderSurface(terminals, id(1));
    fireEvent.click(await screen.findByRole("button", { name: "Terminal 2" }));
    const shown = await screen.findByTestId("screen");
    expect(shown).toHaveTextContent("t-shell");

    // Same owner: the screen stays mounted, no reload and no replay.
    await act(async () => show(id(4)));
    expect(screen.getByTestId("screen")).toBe(shown);
    expect(selectedTab()).toBe("t-shell");
    show(id(7));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-other"));
    show(id(1));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-shell"));
  });

  it("keeps the screen but takes no keys or actions until the next conversation's list confirms its owner", async () => {
    const fake = fakeTerminals({ lists: { 1: [dev], 7: [{ ...shell, id: "t-other" }] } });
    let land: (() => void) | undefined;
    const terminals: RemoteTerminals = {
      ...fake,
      watch: (conversationId, listener) => {
        if (conversationId !== id(7)) return fake.watch(conversationId, listener);
        listener({ kind: "loading" });
        land = () => fake.watch(conversationId, listener);
        return () => {};
      },
    };
    const { show } = renderSurface(terminals, id(1));
    expect(await screen.findByTestId("screen")).toHaveAttribute("data-enabled", "true");

    await act(async () => show(id(7)));
    expect(screen.getByTestId("screen")).toHaveTextContent("t-dev");
    expect(screen.getByTestId("screen")).toHaveAttribute("data-enabled", "false");
    expect(screen.getByRole("button", { name: "New terminal" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Close dev server" })).toBeDisabled();

    await act(async () => land!());
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-other"));
    expect(screen.getByTestId("screen")).toHaveAttribute("data-enabled", "true");
  });

  it("offers a first terminal when there is none, then selects it once the host lists it", async () => {
    const terminals = fakeTerminals({ lists: { 1: [] } });
    renderSurface(terminals, id(1));
    fireEvent.click(await screen.findByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(screen.getByTestId("screen")).toHaveTextContent("t-new-1"));
    expect(selectedTab()).toBe("t-new-1");
  });

  it("selects a new terminal beside existing ones, not the first tab", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev] } });
    renderSurface(terminals, id(1));
    const button = await screen.findByRole("button", { name: "New terminal" });
    await act(async () => fireEvent.click(button));
    await waitFor(() => expect(selectedTab()).toBe("t-new-1"));
  });

  it("disables New terminal once the owner has the host's limit", async () => {
    renderSurface(fakeTerminals({ lists: { 1: [dev, shell] }, limit: 2 }), id(1));
    expect(await screen.findByRole("button", { name: "New terminal" })).toHaveAttribute("aria-disabled", "true");
  });

  it("says why a host has no terminals", () => {
    renderSurface(fakeTerminals({ unavailable: "The host is too old for terminals" }), id(1));
    expect(screen.getByText("The host is too old for terminals")).toBeInTheDocument();
  });

  it("shows an exited terminal's code and restarts it", async () => {
    const terminals = fakeTerminals({ lists: { 1: [tests] } });
    renderSurface(terminals, id(1));
    expect(await screen.findByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("The process exited with code 1.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(terminals.restart).toHaveBeenCalledWith("t-tests", { cols: 80, rows: 24 });
    await waitFor(() => expect(screen.queryByText("exit 1")).toBeNull());
  });

  it("closes a terminal from its tab's close button or a middle click", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev, shell] } });
    renderSurface(terminals, id(1));
    fireEvent.click(await screen.findByRole("button", { name: "Close Terminal 2" }));
    expect(terminals.close).toHaveBeenCalledWith("t-shell");
    // Closing a tab doesn't select it first.
    expect(selectedTab()).toBe("t-dev");
    fireEvent(screen.getByRole("button", { name: "dev server" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(terminals.close).toHaveBeenCalledWith("t-dev");
  });

  it("renames, restarts and closes the right-clicked tab from its context menu", async () => {
    const terminals = fakeTerminals({ lists: { 1: [dev, shell] } });
    renderSurface(terminals, id(1));
    // A real click presses down first, and the menu's events reach the row
    // through the portal: that must not change which tab the menu is for.
    const choose = async (tab: string, item: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: tab }));
      fireEvent.contextMenu(screen.getByRole("button", { name: tab }));
      const menuItem = await screen.findByRole("menuitem", { name: item });
      fireEvent.pointerDown(menuItem);
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
    };
    await screen.findByRole("button", { name: "Terminal 2" });
    await choose("Terminal 2", "Restart");
    expect(terminals.restart).toHaveBeenCalledWith("t-shell", { cols: 80, rows: 24 });
    await choose("Terminal 2", "Close");
    expect(terminals.close).toHaveBeenCalledWith("t-shell");
    await choose("dev server", "Rename");
    expect(await screen.findByRole("dialog", { name: "Rename terminal" })).toBeInTheDocument();
  });
});
