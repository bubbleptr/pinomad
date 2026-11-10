// jsdom: the search box over the Settings sections. It narrows the sidebar
// to the sections that match by name or by what they hold, and Enter opens
// the first one left.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, fakeMachines, HOME_HOST, signedIn } from "../../test/story-fixtures.tsx";
import { SettingsPage, type SectionId } from "./settings-page.tsx";

function renderSettings(machines = fakeMachines(), initialSection: SectionId = "hosts") {
  render(
    <HostsContext.Provider value={fakeHosts()}>
      <AccountContext.Provider value={fakeAccount(signedIn())}>
        <SettingsPage machines={machines} initialKey={HOME_HOST.hostKey} initialSection={initialSection} onClose={vi.fn()} />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });
const search = () => screen.getByRole("textbox", { name: "Search settings" });
// The nav's own way out sits above the sections.
const sections = () =>
  within(nav())
    .queryAllByRole("button")
    .filter((button) => button.getAttribute("aria-label") !== "Close settings")
    .map((button) => button.textContent);

describe("Settings search", () => {
  it("narrows the sections to the ones whose name matches", async () => {
    renderSettings();
    await userEvent.type(search(), "chat");
    expect(sections()).toEqual(["Chats"]);
  });

  // Each merged section is still found by the name of what it absorbed.
  it.each([
    ["archived", "Chats"],
    ["upgrade", "About"],
    ["mcp", "Agents"],
    ["theme", "General"],
    ["this mac", "Hosts"],
  ])("finds %s under %s", async (query, section) => {
    renderSettings();
    await userEvent.type(search(), query);
    expect(sections()).toEqual([section]);
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

const hostPicker = () => screen.queryByRole("combobox", { name: "Host" });

describe("Settings host picker", () => {
  it("sits on a host page, not in the section nav", () => {
    renderSettings(fakeMachines(), "models");
    expect(within(nav()).queryByRole("combobox", { name: "Host" })).toBeNull();
    expect(hostPicker()).toBeTruthy();
  });

  it("stays on the page of a host that isn't connected, so the user can switch away", async () => {
    renderSettings(fakeMachines(), "models");
    await userEvent.click(hostPicker()!);
    await userEvent.click(await screen.findByRole("option", { name: "nas" }));
    expect(await screen.findByText(/isn't connected/)).toBeTruthy();
    expect(hostPicker()).toBeTruthy();
  });

  it("is absent from this device's pages", () => {
    renderSettings(fakeMachines(), "hosts");
    expect(hostPicker()).toBeNull();
  });

  it("names the only host instead of offering a choice", () => {
    renderSettings(fakeMachines().slice(0, 1), "models");
    expect(hostPicker()).toBeNull();
    expect(screen.getByText("kieran-mbp")).toBeTruthy();
  });
});
