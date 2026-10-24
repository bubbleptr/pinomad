import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { LoginFlow } from "@pinomad/protocol/auth.ts";
import { PROTOCOL } from "@pinomad/protocol/frames.ts";
import { fakeRemote, fakeView, HOST_PROVIDERS, PROVIDERS } from "../../test/story-fixtures.tsx";
import { ProvidersSection } from "./providers-section.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/AppFrame/ProvidersSection",
  component: ProvidersSection,
  args: { view, remote: fakeRemote(view) },
} satisfies Meta<typeof ProvidersSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Clicks through the section's pages: each step is a button whose name starts with the text, or matches the pattern. */
const visit = (...steps: (string | RegExp)[]): Story["play"] =>
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const step of steps) {
      await userEvent.click(await canvas.findByRole("button", { name: typeof step === "string" ? new RegExp(`^${step}`) : step }));
    }
  };

/** Connected providers — a subscription, keys, one from the host's environment, two custom endpoints — then the ways to add one. */
export const Home: Story = {};

/** Nothing connected yet. */
export const Empty: Story = (() => {
  const empty = fakeView({
    providers: {
      providers: PROVIDERS.filter((provider) => provider.custom === undefined).map(({ stored: _stored, ambient: _ambient, ...rest }) => rest),
      logins: [],
    },
  });
  return { args: { view: empty, remote: fakeRemote(empty) } };
})();

export const Subscriptions: Story = { play: visit("Subscription") };

export const ApiKeys: Story = { play: visit("API key") };

export const ApiKeysNoMatch: Story = {
  play: async (context) => {
    await visit("API key")!(context);
    await userEvent.type(within(context.canvasElement).getByRole("textbox", { name: "Filter providers" }), "llama.cpp");
  },
};

/** GitHub Copilot's device code, waiting for approval on github.com. */
export const DeviceCodeLogin: Story = { play: visit("Subscription", "GitHub Copilot", "Sign in with GitHub Copilot") };

/** Anthropic's browser sign-in: open the page, paste the code back. Replaces nothing — the stored sign-in is the same kind. */
export const PasteCodeLogin: Story = { play: visit("Subscription", /Anthropic Claude Pro\/Max/, "Sign in with Claude Pro/Max") };

/** An API key login starts on arrival; pi's first prompt is the key itself. */
export const KeyLogin: Story = { play: visit("API key", "Cloudflare Workers AI") };

/** Amazon Bedrock asks how to authenticate before any key. */
export const SelectPrompt: Story = (() => {
  const choosing: LoginFlow = {
    id: "login-bedrock",
    providerId: "amazon-bedrock",
    method: "api_key",
    events: [],
    prompt: {
      id: 1,
      type: "select",
      message: "Select Amazon Bedrock authentication method:",
      options: [
        { id: "bearer-token", label: "Bearer token" },
        { id: "profile", label: "AWS profile", description: "A named profile from ~/.aws on the host" },
        { id: "credential-chain", label: "AWS credential chain", description: "Environment, SSO or instance role" },
      ],
    },
    state: "running",
  };
  const withSelect = fakeView({ providers: { ...HOST_PROVIDERS, logins: [choosing] } });
  return { args: { view: withSelect, remote: fakeRemote(withSelect) }, play: visit("API key", "Amazon Bedrock") };
})();

export const FailedLogin: Story = (() => {
  const failed: LoginFlow = {
    id: "login-deepseek",
    providerId: "deepseek",
    method: "api_key",
    events: [],
    state: "failed",
    error: "api.deepseek.com rejected the key (401 Authentication Fails, Your api key is invalid)",
  };
  const withFailure = fakeView({ providers: { ...HOST_PROVIDERS, logins: [failed] } });
  return { args: { view: withFailure, remote: fakeRemote(withFailure) }, play: visit("API key", "DeepSeek") };
})();

/** A subscription sign-in: sign in again, log out, or switch to a key. */
export const ManageSubscription: Story = { play: visit("Anthropic") };

/** Configured by GEMINI_API_KEY on the host: no log out here, only an override. */
export const ManageAmbient: Story = { play: visit("Google") };

export const AddCustomEndpoint: Story = { play: visit("Custom endpoint") };

export const EditCustomEndpoint: Story = { play: visit("Company LLM gateway") };

export const Disconnected: Story = (() => {
  const offline = fakeView({ connection: "reconnecting" });
  return { args: { view: offline, remote: fakeRemote(offline) } };
})();

/** A 5.1–5.20 host lists its stored logins but can't add providers. */
export const OlderHost: Story = (() => {
  const older = fakeView({ providers: null, host: { protocol: { ...PROTOCOL, minor: 20 } } });
  return { args: { view: older, remote: fakeRemote(older) } };
})();
