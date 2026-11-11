// jsdom: Settings → Models picks the default model and its thinking level in
// two rows, each saved to the host on its own.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountContext } from "../../entities/account/account-context.tsx";
import { HostsContext } from "../../entities/host/host-store.ts";
import { fakeAccount, fakeHosts, fakeMachines, fakeView, HOME_HOST, signedIn } from "../../test/story-fixtures.tsx";
import { SettingsPage } from "./settings-page.tsx";

function renderModels(machines = fakeMachines()) {
  render(
    <HostsContext.Provider value={fakeHosts()}>
      <AccountContext.Provider value={fakeAccount(signedIn())}>
        <SettingsPage machines={machines} initialKey={HOME_HOST.hostKey} initialSection="models" onClose={vi.fn()} />
      </AccountContext.Provider>
    </HostsContext.Provider>,
  );
  return machines[0]!.remote!.controller.updateSettings;
}

describe("Settings models", () => {
  it("saves the picked model as its provider and id", async () => {
    const updateSettings = renderModels();
    await userEvent.click(screen.getByRole("combobox", { name: "Default model" }));
    await userEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(updateSettings).toHaveBeenCalledWith({ defaultModel: { provider: "openai", modelId: "gpt-5" } });
  });

  it("saves the thinking level on its own", async () => {
    const updateSettings = renderModels();
    await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }));
    await userEvent.click(await screen.findByRole("option", { name: "Low" }));
    expect(updateSettings).toHaveBeenCalledWith({ defaultThinkingLevel: "low" });
  });

  it("offers no thinking level for a model that can't reason", () => {
    const base = fakeView();
    const models = base.models.map((model) => ({ ...model, thinkingLevels: ["off" as const] }));
    renderModels(fakeMachines({ home: fakeView({ models }) }));
    expect(screen.getByRole("combobox", { name: "Default model" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
  });
});
