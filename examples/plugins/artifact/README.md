# artifact

An example PiNomad plugin. The model calls `artifact_write` with a title and a whole HTML document; the call's card in the transcript shows the title and an **Open** button, and the **Artifact** side panel renders the page in the client's sandbox, scripts included.

- `plugin.json`: the manifest.
- `host.ts`: the tool, the `read` method, and two states. The page itself is host-only state; the panel fetches it with `read`. A small shared state carries the title and a revision number so the panel knows when to fetch again.
- `web.js`: the tool card and the panel. It is a plain ES module written by hand, with `React.createElement` instead of JSX, so there is no build step. A real plugin would usually bundle its UI from TypeScript or JSX instead; the host serves `web.js` as is either way.

One page per conversation: each call replaces the last one.

To try it, copy this directory to `~/.pinomad/plugins/artifact/` and restart the host (`pinomad service restart`). Plugin UI shows in the web and desktop apps; on the iPhone the tool still works, without the card or the panel. The guide is on the website: [Plugins](https://pinomad.si/docs/plugins/).

`apps/host/test/plugins-gateway.test.ts` and `apps/web/test/web-csp.test.ts` load this directory, so keep them passing when you change it.
