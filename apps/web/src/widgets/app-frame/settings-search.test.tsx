// jsdom: the search box over the Settings sections. It narrows the sidebar
// to the sections that match by name or by what they hold, and Enter opens
// the first one left.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, fakeMachines, HOME_HOST, signedIn } from "../../test/story-fixtures.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";

function renderSettings() {
  render(
    <HostsContext.Provider value={fakeHosts()}>
      <AccountContext.Provider value={fakeAccount(signedIn())}>
        <SettingsDialog machines={fakeMachines()} initialKey={HOME_HOST.hostKey} initialSection="hosts" onClose={vi.fn()} />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });
const search = () => screen.getByRole("textbox", { name: "Search settings" });
const sections = () => within(nav()).queryAllByRole("button").map((button) => button.textContent);

describe("Settings search", () => {
  it("narrows the sections to the ones whose name matches", async () => {
    renderSettings();
    await userEvent.type(search(), "arch");
    expect(sections()).toEqual(["Archived"]);
  });

  it("finds a section by what it holds", async () => {
    renderSettings();
    await userEvent.type(search(), "password");
    expect(sections()).toEqual(["Account"]);
  });

  it("says so when nothing matches", async () => {
    renderSettings();
    await userEvent.type(search(), "zzz");
    expect(sections()).toEqual([]);
    expect(within(nav()).getByText("No settings match")).toBeTruthy();
  });

  it("opens the first match on Enter", async () => {
    renderSettings();
    await userEvent.type(search(), "mod{Enter}");
    expect(await screen.findByRole("heading", { name: "Models" })).toBeTruthy();
  });
});
