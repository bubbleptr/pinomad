// Settings → Providers drives pi's login prompts through the controller; the
// host's answer arrives as a new `providers` snapshot, so each test rerenders
// with the next view the way the stream would.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LoginFlow, ProviderInfo } from "@pinomad/protocol/auth.ts";
import { DisconnectedError, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ProvidersSection } from "./providers-section.tsx";

const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true }, apiKey: { name: "API key" }, stored: { kind: "oauth", subscription: true } },
  { id: "google", name: "Google", apiKey: { name: "API key" }, ambient: "GEMINI_API_KEY" },
  { id: "openai", name: "OpenAI", apiKey: { name: "API key" } },
];

const viewWith = (logins: readonly LoginFlow[] = []): DurableView =>
  ({
    connection: "connected",
    session: { id: "s", directory: "/home/k/.pinomad" },
    auth: { logins: [] },
    providers: { providers: PROVIDERS, logins },
    host: { protocol: { major: 5, minor: 21 } },
  }) as unknown as DurableView;

const flow = (overrides: Partial<LoginFlow>): LoginFlow => ({
  id: "login-1",
  providerId: "openai",
  method: "api_key",
  events: [],
  state: "running",
  ...overrides,
});

function setup({ strict = false, begin }: { strict?: boolean; begin?: () => Promise<string> } = {}) {
  // The host runs one login per provider; a second begin is refused while the first runs.
  let begun = 0;
  const controller = {
    beginLogin: vi.fn(
      begin ??
        (async () => {
          if (++begun > 1) throw new Error("A login for OpenAI is already in progress");
          return "login-1";
        }),
    ),
    answerLogin: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  };
  const remote = { controller } as unknown as RemoteDurable;
  const user = userEvent.setup();
  const wrap = (logins: readonly LoginFlow[]) => {
    const section = <ProvidersSection view={viewWith(logins)} remote={remote} />;
    return strict ? <StrictMode>{section}</StrictMode> : section;
  };
  const result = render(wrap([]));
  const show = (logins: readonly LoginFlow[]) => result.rerender(wrap(logins));
  /** Open OpenAI's API key page; its login starts on arrival. */
  const openKeyLogin = async () => {
    await user.click(screen.getByRole("button", { name: /API key/ }));
    await user.click(screen.getByRole("button", { name: /OpenAI/ }));
    await waitFor(() => expect(controller.beginLogin).toHaveBeenCalledWith("openai", "api_key"));
  };
  return { controller, user, show, openKeyLogin, unmount: result.unmount };
}

describe("ProvidersSection logins", () => {
  it("answers the flow's current prompt by its id", async () => {
    const { controller, user, show, openKeyLogin } = setup();
    await openKeyLogin();

    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    await user.type(await screen.findByLabelText(/Enter OpenAI API key/), "sk-test");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(controller.answerLogin).toHaveBeenLastCalledWith("login-1", 7, "sk-test");

    // The next prompt replaces the answered one; its answer goes to the new id.
    show([flow({ prompt: { id: 8, type: "text", message: "Enter organization ID" } })]);
    await user.type(await screen.findByLabelText(/Enter organization ID/), "org-1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(controller.answerLogin).toHaveBeenLastCalledWith("login-1", 8, "org-1");
  });

  it("begins one login under StrictMode's dev remount", async () => {
    const { controller, show, openKeyLogin } = setup({ strict: true });
    await openKeyLogin();
    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    expect(await screen.findByLabelText(/Enter OpenAI API key/)).toBeInTheDocument();
    expect(controller.beginLogin).toHaveBeenCalledTimes(1);
    expect(controller.cancelLogin).not.toHaveBeenCalled();
  });

  it("picks up the login the host began when the begin result was lost to a disconnect", async () => {
    const { controller, user, show, openKeyLogin } = setup({ begin: async () => Promise.reject(new DisconnectedError()) });
    await openKeyLogin();
    await screen.findByText("Disconnected from host");

    // After the reconnect the host's snapshot still lists the login it began.
    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    await user.type(await screen.findByLabelText(/Enter OpenAI API key/), "sk-test");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(controller.answerLogin).toHaveBeenLastCalledWith("login-1", 7, "sk-test");

    // It is this page's login now: leaving cancels it.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(controller.cancelLogin).toHaveBeenCalledWith("login-1");
    expect(controller.beginLogin).toHaveBeenCalledTimes(1);
  });

  it("leaves another device's login alone when the host refuses the start", async () => {
    const { controller, user, show, openKeyLogin } = setup({
      begin: async () => Promise.reject(new Error("A login for OpenAI is already in progress")),
    });
    await openKeyLogin();
    await screen.findByText("A login for OpenAI is already in progress");

    // Another device's login for the same provider is running on the host.
    show([flow({ id: "login-other", prompt: { id: 3, type: "secret", message: "Enter OpenAI API key" } })]);
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByLabelText(/Enter OpenAI API key/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(controller.cancelLogin).not.toHaveBeenCalled();
  });

  it("cancels a running login it started when the page is left", async () => {
    const { controller, user, show, openKeyLogin } = setup();
    await openKeyLogin();
    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    await screen.findByLabelText(/Enter OpenAI API key/);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(controller.cancelLogin).toHaveBeenCalledWith("login-1");
  });

  it("does not cancel a login that already succeeded", async () => {
    const { controller, show, openKeyLogin } = setup();
    await openKeyLogin();
    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    await screen.findByLabelText(/Enter OpenAI API key/);

    await act(async () => show([flow({ state: "succeeded" })]));
    // Success returns to the section home.
    await screen.findByRole("list", { name: "Connected" });
    expect(controller.cancelLogin).not.toHaveBeenCalled();
  });

  it("leaves the page when the host drops a flow it had listed", async () => {
    const { controller, show, openKeyLogin } = setup();
    await openKeyLogin();
    show([flow({ prompt: { id: 7, type: "secret", message: "Enter OpenAI API key" } })]);
    await screen.findByLabelText(/Enter OpenAI API key/);

    // The end was missed (a reconnect past the host's hold): the flow is just gone.
    await act(async () => show([]));
    // Back on the API key grid, the way Cancel leaves.
    await screen.findByRole("button", { name: /OpenAI/ });
    expect(screen.queryByLabelText(/Enter OpenAI API key/)).toBeNull();
    expect(controller.cancelLogin).not.toHaveBeenCalled();
  });

  it("offers no log out for a provider configured only by the host's environment", async () => {
    const { user } = setup();
    const connectedRow = (name: string) => within(screen.getByRole("list", { name: "Connected" })).getByRole("button", { name: new RegExp(name) });
    await user.click(connectedRow("Google"));
    await screen.findByRole("heading", { name: "Google" });
    expect(screen.queryByRole("button", { name: /Log out|Remove/ })).toBeNull();

    // A stored credential's page does offer it.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(connectedRow("Anthropic"));
    expect(await screen.findByRole("button", { name: /Log out/ })).toBeInTheDocument();
  });
});
