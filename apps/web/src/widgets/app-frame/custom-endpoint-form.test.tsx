// "Fetch from /models" answers for the endpoint as it was when asked; an
// answer that arrives after the form moved on must not land in it.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { CustomEndpointForm } from "./custom-endpoint-form.tsx";

function setup() {
  let answer!: (models: string[]) => void;
  const controller = {
    listEndpointModels: vi.fn(() => new Promise<string[]>((resolve) => (answer = resolve))),
    saveCustomProvider: vi.fn(async () => {}),
  };
  const remote = { controller } as unknown as RemoteDurable;
  render(<CustomEndpointForm providers={[]} remote={remote} connected onDone={() => {}} onCancel={() => {}} />);
  const user = userEvent.setup();
  const models = () => screen.getByRole("textbox", { name: /Models/ });
  const askFor = async (url: string) => {
    await user.type(screen.getByRole("textbox", { name: /Base URL/ }), url);
    await user.click(screen.getByRole("button", { name: "Fetch from /models" }));
    expect(controller.listEndpointModels).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: url }));
  };
  return { user, models, askFor, answer: (list: string[]) => act(async () => answer(list)) };
}

describe("CustomEndpointForm model fetch", () => {
  it("drops an answer for a base URL the form no longer has", async () => {
    const { user, models, askFor, answer } = setup();
    await askFor("http://a.local/v1");

    const url = screen.getByRole("textbox", { name: /Base URL/ });
    await user.clear(url);
    await user.type(url, "http://b.local/v1");
    await answer(["a-only-model"]);

    expect(models()).toHaveValue("");
  });

  it("keeps models typed while the answer was on its way", async () => {
    const { user, models, askFor, answer } = setup();
    await askFor("http://a.local/v1");

    await user.type(models(), "my-model");
    await answer(["listed-model"]);

    expect(models()).toHaveValue("my-model");
  });

  it("fills the models when nothing changed in between", async () => {
    const { models, askFor, answer } = setup();
    await askFor("http://a.local/v1");
    await answer(["llama-4", "qwen3"]);

    expect(models()).toHaveValue("llama-4\nqwen3");
  });
});
