# artifact

An example PiNomad plugin. The model calls `artifact_write` with a title and a whole HTML document; the call's card in the transcript shows the title and an **Open** button, and the **Artifact** side panel renders the page in the client's sandbox, scripts included.

- `package.json`: the plugin's name.
- `server.ts`: the tool, the `read` method, and two states. The page itself is host-only state; the panel fetches it with `read`. A small shared state carries the title and a revision number so the panel knows when to fetch again.
- `web.tsx`: the tool card and the panel, in JSX. The host builds it; JSX renders with the shell's React, and hooks come from the API object.

One page per conversation: each call replaces the last one.

To try it, copy this directory to `~/.pinomad/plugins/artifact/`; the running host loads it, and reloads it when you edit a file. Plugin UI shows in the web and desktop apps (reload the page to see an edited panel or card); on the iPhone the tool still works, without the card or the panel. The guide is on the website: [Plugins](https://pinomad.si/docs/plugins/).

`apps/host/test/plugins-gateway.test.ts` and `apps/web/test/web-csp.test.ts` load this directory, so keep them passing when you change it.
