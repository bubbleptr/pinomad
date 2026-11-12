// jsdom: a host's plugin bundles become side-panel surfaces and tool cards
// (ADR-0049). The evaluator is injected, so the "module" is a plain function;
// the bytes still go through the hash check.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebPlugin } from "@pinomad/plugin/v1/web";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable, RemotePlugins } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView, ExtensionDocView } from "@pinomad/protocol/view.ts";
import type { CotView } from "@pinomad/client/cot-view.ts";
import { fakeRemote, fakeView, PARSER_ID } from "../../test/story-fixtures.tsx";
import { SidePanel, SurfaceButtons, type PanelSurface } from "../../widgets/side-panel/side-panel.tsx";
import { fillToolDetails } from "../../widgets/chat/tool-detail.tsx";
import { PluginHostProvider, PluginScope, usePluginRegistry, usePluginWorkbench } from "./plugin-host.tsx";
import type { EvaluateModule, PluginRegistry } from "./load-plugins.ts";

const BOARD = "plugin.notes.board";

/** The bytes the host would serve; non-ASCII so the hash covers UTF-8, not UTF-16. */
const codeOf = (name: string) => `// ${name} ✓`;
const info = (name: string, code = codeOf(name)): PluginInfo => ({
  name,
  api: 1,
  web: { hash: bytesToHex(sha256(new TextEncoder().encode(code))), size: code.length },
});

/** Each plugin's "module" is looked up by its code. */
const evaluator = (modules: Record<string, WebPlugin>): EvaluateModule =>
  async (code) => {
    const entry = Object.entries(modules).find(([name]) => codeOf(name) === code);
    if (entry === undefined) throw new Error("unknown module");
    return { default: entry[1] };
  };

const notes: WebPlugin = (pinomad) => {
  const { createElement } = pinomad.React;
  const Board = () => {
    const board = pinomad.useState<{ notes: string[] }>("board");
    return createElement(
      "div",
      null,
      createElement("p", null, board === undefined ? "No board yet" : `Notes: ${board.notes.join(", ")}`),
      createElement("button", { type: "button", onClick: () => void pinomad.call("add", "from the panel") }, "Add note"),
    );
  };
  pinomad.panel({ id: "board", label: "Notes", component: Board });
  pinomad.toolCard("notes_add", ({ tool }) => createElement("p", null, `Card for ${String((tool.args as { text?: string })?.text)}`));
};

let host: { setDocs(docs: readonly ExtensionDocView[]): void; registry(): PluginRegistry } | undefined;

function setup(
  plugins: readonly PluginInfo[],
  modules: Record<string, WebPlugin>,
  codes: Record<string, string> = {},
  surface: PanelSurface = "plugin:notes:board",
) {
  const call = vi.fn<RemotePlugins["call"]>(async () => null);
  const bundle = vi.fn<RemotePlugins["bundle"]>(async (name) => codes[name] ?? codeOf(name));
  const view: DurableView = fakeView({ host: { protocol: { major: 5, minor: 34 }, plugins }, docs: [] });
  const remote: RemoteDurable = { ...fakeRemote(view), plugins: { bundle, call } };
  let latest: PluginRegistry | undefined;
  function Probe() {
    latest = usePluginRegistry();
    return null;
  }
  function Workbench({ docs, surface }: { docs: readonly ExtensionDocView[]; surface: PanelSurface }) {
    const registry = usePluginWorkbench(PARSER_ID, () => {});
    return (
      <PluginScope conversationId={PARSER_ID} docs={docs}>
        <Probe />
        <SurfaceButtons narrow={false} open surface={surface} liveActivity={false} pluginPanels={registry.panels} onSelect={() => {}} />
        <SidePanel
          view={view}
          remote={remote}
          shownId={PARSER_ID}
          narrow={false}
          open
          surface={surface}
          pluginPanels={registry.panels}
          busy={false}
          liveActivity={false}
          onOpenChange={() => {}}
          onSelectSurface={() => {}}
          openInPanel={() => {}}
          onOpenInMain={() => {}}
        />
      </PluginScope>
    );
  }
  const evaluate = evaluator(modules);
  const ui = (docs: readonly ExtensionDocView[]) => (
    <PluginHostProvider remote={remote} evaluate={evaluate}>
      <Workbench docs={docs} surface={surface} />
    </PluginHostProvider>
  );
  const { rerender } = render(ui([]));
  host = { setDocs: (docs) => rerender(ui(docs)), registry: () => latest! };
  return { call, bundle, host };
}

afterEach(() => {
  host = undefined;
  vi.restoreAllMocks();
});

describe("plugin surfaces", () => {
  it("adds the plugin's panel after the built-in surfaces and renders it from the shared state", async () => {
    const { call } = setup([info("notes")], { notes });
    await screen.findByRole("button", { name: "Notes" });
    const buttons = screen.getAllByRole("button", { name: /^(Tasks|Changes|Terminal|Notes)$/ });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Tasks", "Changes", "Terminal", "Notes"]);
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("No board yet")).toBeVisible();

    act(() => host!.setDocs([{ kind: BOARD, value: { notes: ["first"] } }]));
    expect(screen.getByText("Notes: first")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(call).toHaveBeenCalledWith(PARSER_ID, "notes", "add", "from the panel");
  });

  it("shows Tasks while the stored plugin surface is not (or no longer) registered", () => {
    setup([], {});
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Notes" })).toBeNull();
    expect(screen.queryByText("No board yet")).toBeNull();
  });

  it("keeps the panel up with an inline message when the plugin's component throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup([info("broken")], {
      broken: (pinomad) =>
        pinomad.panel({
          id: "board",
          label: "Notes",
          component: () => {
            throw new Error("render failed");
          },
        }),
    }, {}, "plugin:broken:board");
    expect(await screen.findByText("The broken plugin could not show this.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeVisible();
  });
});

describe("plugin loading", () => {
  it("skips a bundle whose bytes do not match the announced hash, and one whose default export throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setup(
      [info("tampered"), info("throws"), info("notes")],
      {
        tampered: notes,
        throws: (pinomad) => {
          pinomad.panel({ id: "half", label: "Half", component: () => null });
          throw new Error("boom");
        },
        notes,
      },
      { tampered: "// tampered ✗" },
    );
    await waitFor(() => expect(host!.registry().panels.map((panel) => panel.plugin)).toEqual(["notes"]));
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("loads nothing for a host without plugins", async () => {
    const { bundle } = setup([], { notes });
    await act(async () => {});
    expect(bundle).not.toHaveBeenCalled();
    expect(host!.registry().panels).toEqual([]);
  });
});

describe("plugin tool cards", () => {
  it("replaces the detail of the plugin's tool only; built-in details keep theirs", async () => {
    setup([info("notes")], { notes });
    await waitFor(() => expect(host!.registry().toolCards.size).toBe(1));
    const cot = {
      phase: "settled",
      steps: [
        {
          kind: "tools",
          tools: [
            { toolName: "notes_add", argsText: '{"text":"milk"}', output: "Added note 1", state: "output-available" },
            { toolName: "read", argsText: '{"path":"a.ts"}', output: "x", state: "output-available" },
            {
              toolName: "notes_add",
              argsText: '{"text":"diffed"}',
              state: "output-available",
              pinomad: { kind: "diff", patch: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n" },
            },
          ],
        },
      ],
    } as unknown as CotView;
    const filled = fillToolDetails(cot, host!.registry().toolCards);
    const [card, read, diffed] = (filled.steps[0] as { tools: { detail?: React.ReactNode }[] }).tools;
    expect(read!.detail).toBeUndefined();
    expect(diffed!.detail).toBeDefined();
    render(<PluginScope conversationId={PARSER_ID} docs={[]}>{diffed!.detail}</PluginScope>);
    expect(screen.queryByText(/Card for/)).toBeNull();
    render(<PluginScope conversationId={PARSER_ID} docs={[]}>{card!.detail}</PluginScope>);
    expect(screen.getByText("Card for milk")).toBeVisible();
  });
});
