// A host-built plugin bundle through the client's own loader (ADR-0050): the
// host builds `web.tsx`, the client imports the module and calls its default
// export. Run in Node, with a data: import for the client's blob import.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { WebApi } from "@pinomad/plugin/v1/web";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import { connectTo, startFauxHost, tempDir, useCleanups, waitForView } from "@pinomad/host/test/support.ts";
import { loadPlugins } from "../src/entities/plugin/load-plugins.ts";

const defer = useCleanups();
afterEach(() => vi.restoreAllMocks());

/** A host with the given browser halves: its hello's plugins and `pluginBundle`, through the client. */
async function hostWith(plugins: Record<string, string>) {
  const dir = await tempDir();
  defer(dir.remove);
  for (const [name, web] of Object.entries(plugins)) {
    await mkdir(join(dir.path, "plugins", name), { recursive: true });
    await writeFile(join(dir.path, "plugins", name, "package.json"), JSON.stringify({ name }));
    await writeFile(join(dir.path, "plugins", name, "web.tsx"), web);
  }
  const host = await startFauxHost(defer, { dataDir: dir.path });
  const client = await connectTo(defer, host);
  await waitForView(client.view, (view) => (view.host?.plugins?.length ?? 0) === Object.keys(plugins).length);
  return { info: client.view.current().host!.plugins!, bundle: (name: string) => client.plugins.bundle(name) };
}

const load = (info: readonly PluginInfo[], bundle: (name: string) => Promise<string>) =>
  loadPlugins(info, {
    bundle,
    evaluate: async (code) => (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { default?: unknown },
    api: (_name, registrar) => ({ ...registrar, React }) as unknown as WebApi,
  });

it("renders JSX written at the top level of web.tsx with the shell's React", async () => {
  const { info, bundle } = await hostWith({
    toplevel:
      'import type { WebApi } from "@pinomad/plugin/v1/web";\n' +
      "const empty = <p>Nothing here yet</p>;\n" +
      'export default function (pinomad: WebApi) { pinomad.panel({ id: "p", label: "Top", component: () => empty }); }\n',
  });
  const { registry, failed } = await load(info, bundle);
  expect(failed).toBe(false);
  const [panel] = registry.panels;
  expect(renderToStaticMarkup(React.createElement(panel!.component))).toBe("<p>Nothing here yet</p>");
});

it("renders JSX that puts a key after a spread, which compiles to react's createElement", async () => {
  const { info, bundle } = await hostWith({
    spread:
      'import type { WebApi } from "@pinomad/plugin/v1/web";\n' +
      "const Row = (props: { title: string; id: string }) => <div {...props} key={props.id}>Spread first</div>;\n" +
      'export default function (pinomad: WebApi) { pinomad.panel({ id: "p", label: "Spread", component: () => <Row title="t" id="a" /> }); }\n',
  });
  const { registry, failed } = await load(info, bundle);
  expect(failed).toBe(false);
  expect(renderToStaticMarkup(React.createElement(registry.panels[0]!.component))).toBe('<div title="t" id="a">Spread first</div>');
});

it("gives an import from react the shell's React, hooks included", async () => {
  const { info, bundle } = await hostWith({
    hooks:
      'import { useState } from "react";\n' +
      'import type { WebApi } from "@pinomad/plugin/v1/web";\n' +
      "function Counter() { const [count] = useState(3); return <p>Count {count}</p>; }\n" +
      'export default function (pinomad: WebApi) { pinomad.panel({ id: "p", label: "Hooks", component: Counter }); }\n',
  });
  const { registry, failed } = await load(info, bundle);
  expect(failed).toBe(false);
  expect(renderToStaticMarkup(React.createElement(registry.panels[0]!.component))).toBe("<p>Count 3</p>");
});

it("still reports a browser half without a default export function", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { info, bundle } = await hostWith({ nodefault: "export const unused = 1;\n" });
  const { registry, failed } = await load(info, bundle);
  expect(failed).toBe(true);
  expect(registry.panels).toEqual([]);
  expect(String(errors.mock.calls[0]?.[1])).toContain("the browser half has no default export function");
});
