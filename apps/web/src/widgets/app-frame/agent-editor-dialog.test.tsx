// jsdom: a new agent whose name is already taken is said on the Name field,
// before the host refuses it with a plain message.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { fakeView } from "../../test/story-fixtures.tsx";
import { AgentEditorDialog } from "./agent-editor-dialog.tsx";

function renderNew(view = fakeView()) {
  const createAgent = vi.fn(async () => {});
  const remote = { controller: { createAgent, updateAgent: vi.fn(async () => {}) } } as unknown as RemoteDurable;
  render(<AgentEditorDialog view={view} remote={remote} connected onClose={() => {}} />);
  return { createAgent, user: userEvent.setup() };
}

async function fill(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByRole("textbox", { name: "Name" }), name);
  await user.type(screen.getByRole("textbox", { name: "Description" }), "Does things");
  await user.type(screen.getByRole("textbox", { name: /Prompt/ }), "You do things.");
  await user.click(screen.getByRole("button", { name: "Save" }));
}

describe("AgentEditorDialog", () => {
  it("puts a name another agent has on the Name field and doesn't ask the host", async () => {
    const { createAgent, user } = renderNew();
    await fill(user, "reviewer");
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/already/);
    expect(createAgent).not.toHaveBeenCalled();

    await user.type(name, "-2");
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("counts a file the host couldn't load as taken too", async () => {
    const { createAgent, user } = renderNew(
      fakeView({ agents: { roles: [], problems: [{ file: "helper.md", reason: "description is missing" }] } }),
    );
    await fill(user, "helper");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
    expect(createAgent).not.toHaveBeenCalled();
  });
});
