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
import { EMPTY_PLUGIN_REGISTRY, type EvaluateModule, type PluginRegistry } from "./load-plugins.ts";

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

/** A remote whose view the test drives; only what PluginHostProvider reads. */
function liveRemote(plugins: readonly PluginInfo[], connection: DurableView["connection"]) {
  let view: DurableView = fakeView({ host: { protocol: { major: 5, minor: 34 }, plugins }, docs: [], connection });
  const listeners = new Set<() => void>();
  const bundle = vi.fn<RemotePlugins["bundle"]>(async (name) => codeOf(name));
  const call = vi.fn<RemotePlugins["call"]>(async () => null);
  const remote = {
    ...fakeRemote(view),
    view: {
      current: () => view,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    plugins: { bundle, call },
  } as RemoteDurable;
  const set = (patch: Partial<DurableView>) =>
    act(() => {
      view = { ...view, ...patch };
      for (const listener of listeners) listener();
    });
  const setConnection = (next: DurableView["connection"]) => set({ connection: next });
  /** A host `plugins` frame after a reload. */
  const setPlugins = (next: readonly PluginInfo[]) => set({ host: { ...view.host!, plugins: next } });
  return { remote, bundle, call, setConnection, setPlugins };
}

function RegistryProbe({ onRegistry }: { onRegistry: (registry: PluginRegistry) => void }) {
  onRegistry(usePluginRegistry());
  return null;
}

describe("plugin loading across reconnects", () => {
  it("waits for the connection to accept calls, then retries only the bundle that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { remote, bundle, setConnection } = liveRemote([info("flaky"), info("steady")], "reconnecting");
    let first = true;
    bundle.mockImplementation(async (name) => {
      if (name === "flaky" && first) {
        first = false;
        throw new Error("Disconnected from host");
      }
      return codeOf(name);
    });
    let registry = EMPTY_PLUGIN_REGISTRY;
    const panel = (id: string): WebPlugin => (pinomad) => pinomad.panel({ id, label: id, component: () => null });
    render(
      <PluginHostProvider remote={remote} evaluate={evaluator({ flaky: panel("flaky"), steady: panel("steady") })}>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PluginHostProvider>,
    );
    await act(async () => {});
    expect(bundle).not.toHaveBeenCalled();

    setConnection("connected");
    await waitFor(() => expect(registry.panels.map((entry) => entry.plugin)).toEqual(["steady"]));

    setConnection("reconnecting");
    setConnection("connected");
    await waitFor(() => expect(registry.panels.map((entry) => entry.plugin)).toEqual(["flaky", "steady"]));
    expect(bundle.mock.calls.map(([name]) => name).sort()).toEqual(["flaky", "flaky", "steady"]);
  });
});

describe("plugin loading after a reload", () => {
  it("fetches a changed plugin's bundle by the hash the new list announces", async () => {
    const before = info("panel");
    const code = "// panel, edited ✓";
    const after = info("panel", code);
    const { remote, bundle, setPlugins } = liveRemote([before], "connected");
    bundle.mockImplementation(async (name, hash) => (hash === after.web!.hash ? code : codeOf(name)));
    const panel = (label: string): WebPlugin => (pinomad) => pinomad.panel({ id: "p", label, component: () => null });
    const evaluate: EvaluateModule = async (source) => ({ default: panel(source === code ? "Edited" : "Original") });
    let registry = EMPTY_PLUGIN_REGISTRY;
    render(
      <PluginHostProvider remote={remote} evaluate={evaluate}>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PluginHostProvider>,
    );
    await waitFor(() => expect(registry.panels.map((entry) => entry.label)).toEqual(["Original"]));

    setPlugins([after]);
    await waitFor(() => expect(registry.panels.map((entry) => entry.label)).toEqual(["Edited"]));
    expect(bundle.mock.calls).toEqual([
      ["panel", before.web!.hash],
      ["panel", after.web!.hash],
    ]);
  });

  /** The side panel showing `surface`, over a remote the test drives. */
  function ShownPanel({ remote, surface }: { remote: RemoteDurable; surface: PanelSurface }) {
    const registry = usePluginWorkbench(PARSER_ID, () => {});
    return (
      <PluginScope conversationId={PARSER_ID} docs={[]}>
        <SidePanel
          view={remote.view.current()}
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

  /** Each module by its exact source; `codeOf(name)` is the first version. */
  const bySource =
    (modules: Record<string, WebPlugin>): EvaluateModule =>
    async (source) => {
      const plugin = modules[source];
      if (plugin === undefined) throw new Error("unknown module");
      return { default: plugin };
    };

  it("keeps the open panel of a plugin the reload left alone mounted, and never blanks the panels in between", async () => {
    const counter: WebPlugin = (pinomad) => {
      const { createElement, useState } = pinomad.React;
      const Counter = () => {
        const [clicks, setClicks] = useState(0);
        return createElement("button", { type: "button", onClick: () => setClicks(clicks + 1) }, `Clicked ${clicks}`);
      };
      pinomad.panel({ id: "p", label: "Counter", component: Counter });
    };
    const labelled = (label: string): WebPlugin => (pinomad) => pinomad.panel({ id: "p", label, component: () => null });
    const edited = "// other, edited ✓";
    const { remote, bundle, setPlugins } = liveRemote([info("keeper"), info("other")], "connected");
    bundle.mockImplementation(async (name, hash) => (hash === info("other", edited).web!.hash ? edited : codeOf(name)));
    const seen: string[][] = [];
    render(
      <PluginHostProvider
        remote={remote}
        evaluate={bySource({ [codeOf("keeper")]: counter, [codeOf("other")]: labelled("Other"), [edited]: labelled("Other, edited"), [codeOf("added")]: () => {} })}
      >
        <RegistryProbe onRegistry={(next) => seen.push(next.panels.map((panel) => panel.label))} />
        <ShownPanel remote={remote} surface="plugin:keeper:p" />
      </PluginHostProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Clicked 0" }));
    expect(screen.getByRole("button", { name: "Clicked 1" })).toBeVisible();
    const loaded = seen.length;

    setPlugins([info("keeper"), info("other", edited), info("added")]);
    await waitFor(() => expect(seen.at(-1)).toEqual(["Counter", "Other, edited"]));
    expect(screen.getByRole("button", { name: "Clicked 1" })).toBeVisible();
    expect(seen.slice(loaded).filter((labels) => labels.length < 2)).toEqual([]);
    // Only the changed and the new bundle were fetched again.
    expect(bundle.mock.calls.slice(2).map(([name]) => name).sort()).toEqual(["added", "other"]);
  });

  it("keeps a plugin's loaded version when its new bundle does not load in the browser", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const edited = "// kept, throws ✓";
    const { remote, bundle, setPlugins } = liveRemote([info("kept")], "connected");
    bundle.mockImplementation(async (name, hash) => (hash === info("kept", edited).web!.hash ? edited : codeOf(name)));
    const throwing: WebPlugin = () => {
      throw new Error("setup failed");
    };
    let registry = EMPTY_PLUGIN_REGISTRY;
    render(
      <PluginHostProvider
        remote={remote}
        evaluate={bySource({ [codeOf("kept")]: (pinomad) => pinomad.panel({ id: "p", label: "Original", component: () => null }), [edited]: throwing })}
      >
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PluginHostProvider>,
    );
    await waitFor(() => expect(registry.panels.map((entry) => entry.label)).toEqual(["Original"]));

    setPlugins([info("kept", edited)]);
    await waitFor(() => expect(errors).toHaveBeenCalledWith("Plugin kept was not loaded:", expect.any(Error)));
    await act(async () => {});
    expect(registry.panels.map((entry) => entry.label)).toEqual(["Original"]);
  });

  it("drops a removed plugin's panel and tool card", async () => {
    const { remote, setPlugins } = liveRemote([info("notes")], "connected");
    let registry = EMPTY_PLUGIN_REGISTRY;
    render(
      <PluginHostProvider remote={remote} evaluate={evaluator({ notes })}>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
        <ShownPanel remote={remote} surface="plugin:notes:board" />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("No board yet")).toBeVisible();
    expect([...registry.toolCards.keys()]).toEqual(["notes_add"]);

    setPlugins([]);
    await waitFor(() => expect(registry.panels).toEqual([]));
    expect(registry.toolCards.size).toBe(0);
    expect(screen.queryByText("No board yet")).toBeNull();
  });

  it("shows a fixed version of a panel that had failed to render", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixed = "// crashy, fixed ✓";
    const { remote, bundle, setPlugins } = liveRemote([info("crashy")], "connected");
    bundle.mockImplementation(async (name, hash) => (hash === info("crashy", fixed).web!.hash ? fixed : codeOf(name)));
    const panel =
      (component: () => React.ReactNode): WebPlugin =>
      (pinomad) =>
        pinomad.panel({ id: "p", label: "Broken", component });
    render(
      <PluginHostProvider
        remote={remote}
        evaluate={bySource({
          [codeOf("crashy")]: panel(() => {
            throw new Error("render failed");
          }),
          [fixed]: panel(() => "Fixed now"),
        })}
      >
        <ShownPanel remote={remote} surface="plugin:crashy:p" />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("The crashy plugin could not show this.")).toBeVisible();

    setPlugins([info("crashy", fixed)]);
    expect(await screen.findByText("Fixed now")).toBeVisible();
  });
});

describe("plugin calls after the workbench goes", () => {
  it("rejects a late call instead of writing to the conversation that was shown", async () => {
    const { remote, call } = liveRemote([info("late")], "connected");
    let api: Parameters<WebPlugin>[0] | undefined;
    function Workbench() {
      usePluginWorkbench(PARSER_ID, () => {});
      return null;
    }
    const ui = (workbench: boolean) => (
      <PluginHostProvider remote={remote} evaluate={evaluator({ late: (pinomad) => void (api = pinomad) })}>
        {workbench ? <Workbench /> : null}
      </PluginHostProvider>
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(api).toBeDefined());
    await api!.call("add", "while shown");
    expect(call).toHaveBeenCalledTimes(1);

    rerender(ui(false));
    await expect(api!.call("add", "too late")).rejects.toThrow("No conversation is shown");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
