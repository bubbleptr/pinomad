// The models picker lists what the endpoint serves and saves only what's
// checked. A fetch answers for the endpoint as it was when asked; an answer
// that arrives after the form moved on must not land in it.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@pinomad/protocol/auth.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { CustomEndpointForm } from "./custom-endpoint-form.tsx";

// jsdom lacks the popover API the models dropdown opens with.
beforeEach(() => {
  HTMLElement.prototype.showPopover = function (this: HTMLElement) {
    this.setAttribute("popover-open", "");
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "open" });
    this.dispatchEvent(event);
  };
  HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
    this.removeAttribute("popover-open");
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "closed" });
    this.dispatchEvent(event);
  };
  const matches = Element.prototype.matches;
  HTMLElement.prototype.matches = function (this: HTMLElement, selector: string) {
    return selector === ":popover-open" ? this.hasAttribute("popover-open") : matches.call(this, selector);
  };
});

const hidden = { hidden: true } as const;

const OLLAMA: ProviderInfo = {
  id: "ollama-on-studio",
  name: "Ollama on studio",
  apiKey: { name: "API key" },
  custom: { api: "openai-completions", baseUrl: "http://studio.local:11434/v1", models: ["gpt-oss:120b", "devstral:24b"] },
};

function setup(existing?: ProviderInfo) {
  let answer!: (models: string[]) => void;
  const controller = {
    listEndpointModels: vi.fn(() => new Promise<string[]>((resolve) => (answer = resolve))),
    saveCustomProvider: vi.fn(async () => {}),
    removeCustomProvider: vi.fn(async () => {}),
  };
  const remote = { controller } as unknown as RemoteDurable;
  const onDone = vi.fn();
  const onRemoved = vi.fn();
  render(
    <CustomEndpointForm
      existing={existing}
      providers={existing === undefined ? [] : [existing]}
      remote={remote}
      connected
      onDone={onDone}
      onCancel={() => {}}
      onRemoved={onRemoved}
    />,
  );
  const user = userEvent.setup();
  const openModels = async () => {
    await user.click(screen.getByRole("button", { name: /^Models/ }));
    return screen.getByRole("listbox", { name: /^Models/, ...hidden });
  };
  /** Every model the dropdown offers, and the checked ones. */
  const offered = async () => {
    const options = within(await openModels())
      .getAllByRole("option", hidden)
      .filter((option) => option.textContent !== "Select all");
    await user.keyboard("{Escape}");
    return {
      all: options.map((option) => option.textContent),
      checked: options.filter((option) => option.getAttribute("aria-selected") === "true").map((option) => option.textContent),
    };
  };
  const askFor = async (url: string) => {
    await user.type(screen.getByRole("textbox", { name: /Base URL/ }), url);
    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(controller.listEndpointModels).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: url }));
  };
  const addModel = async (id: string) => {
    await user.type(screen.getByRole("textbox", { name: /Add model ID/ }), `${id}{Enter}`);
  };
  const save = async () => {
    await user.click(screen.getByRole("button", { name: existing === undefined ? "Add endpoint" : "Save changes" }));
  };
  const savedModels = () => (controller.saveCustomProvider.mock.calls.at(-1) as unknown as [{ models: string[] }] | undefined)?.[0].models;
  return {
    user,
    controller,
    onDone,
    onRemoved,
    openModels,
    offered,
    askFor,
    addModel,
    save,
    savedModels,
    answer: (list: string[]) => act(async () => answer(list)),
  };
}

describe("CustomEndpointForm adding an endpoint", () => {
  it("drops an answer for a base URL the form no longer has", async () => {
    const { user, askFor, answer, addModel, offered } = setup();
    await askFor("http://a.local/v1");

    const url = screen.getByRole("textbox", { name: /Base URL/ });
    await user.clear(url);
    await user.type(url, "http://b.local/v1");
    await answer(["a-only-model"]);
    await addModel("mine");

    expect((await offered()).all).toEqual(["mine"]);
  });

  it("checks every listed model when nothing was checked yet", async () => {
    const { user, askFor, answer, save, savedModels } = setup();
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Local");
    await askFor("http://a.local/v1");
    await answer(["llama-4", "qwen3"]);
    await save();

    expect(savedModels()).toEqual(["llama-4", "qwen3"]);
  });

  it("keeps a model added by hand while the answer was on its way, and offers the listed ones", async () => {
    const { user, askFor, answer, addModel, offered, save, savedModels } = setup();
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Local");
    await askFor("http://a.local/v1");
    await addModel("my-model");
    await answer(["listed-model"]);

    expect(await offered()).toEqual({ all: ["my-model", "listed-model"], checked: ["my-model"] });
    await save();
    expect(savedModels()).toEqual(["my-model"]);
  });

  it("refuses to save with no model checked", async () => {
    const { user, controller, save } = setup();
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Local");
    await user.type(screen.getByRole("textbox", { name: /Base URL/ }), "http://a.local/v1");
    await save();

    expect(screen.getByText("Add at least one model")).toBeInTheDocument();
    expect(controller.saveCustomProvider).not.toHaveBeenCalled();
  });
});

describe("CustomEndpointForm editing an endpoint", () => {
  it("lists the endpoint's models on open without changing which are checked", async () => {
    const { controller, answer, offered } = setup(OLLAMA);
    expect(controller.listEndpointModels).toHaveBeenCalledWith(expect.objectContaining({ providerId: OLLAMA.id }));
    await answer(["qwen3-coder:30b", "gpt-oss:120b", "devstral:24b"]);

    const { all, checked } = await offered();
    expect([...all].sort()).toEqual(["devstral:24b", "gpt-oss:120b", "qwen3-coder:30b"]);
    expect([...checked].sort()).toEqual(["devstral:24b", "gpt-oss:120b"]);
  });

  it("saves only the checked models", async () => {
    const { user, answer, openModels, save, savedModels } = setup(OLLAMA);
    await answer(["qwen3-coder:30b", "gpt-oss:120b", "devstral:24b"]);

    const list = await openModels();
    await user.click(within(list).getByRole("option", { name: /devstral:24b/, ...hidden }));
    await user.click(within(list).getByRole("option", { name: /qwen3-coder:30b/, ...hidden }));
    await user.keyboard("{Escape}");
    await save();

    expect([...(savedModels() ?? [])].sort()).toEqual(["gpt-oss:120b", "qwen3-coder:30b"]);
  });

  it("saves a model added by hand", async () => {
    const { answer, addModel, save, savedModels } = setup(OLLAMA);
    await answer([]);
    await addModel("llama3.3:70b");
    await save();

    expect([...(savedModels() ?? [])].sort()).toEqual(["devstral:24b", "gpt-oss:120b", "llama3.3:70b"]);
  });

  it("removes the endpoint only after confirming", async () => {
    const { user, controller, onRemoved } = setup(OLLAMA);
    await user.click(screen.getByRole("button", { name: "Remove endpoint…" }));
    expect(controller.removeCustomProvider).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog", hidden);
    await user.click(within(dialog).getByRole("button", { name: "Remove endpoint", ...hidden }));

    expect(controller.removeCustomProvider).toHaveBeenCalledWith(OLLAMA.id);
    expect(onRemoved).toHaveBeenCalled();
  });
});
