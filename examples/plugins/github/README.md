# github

An example PiNomad plugin that keeps a credential away from the agent (ADR-0052 §6). The agent calls `github_open_pr`, `github_comment` and `git_push`; the plugin adds the `github_token` secret in the host process, so the token is never in the conversation, a tool result or the agent's environment.

- `package.json`: the plugin's name.
- `server.ts`: the secret and the three tools. `git_push` pushes the conversation checkout's `HEAD` to a branch. It reads the commit from the checkout without the token, then pushes from a scratch repository the host makes (borrowing the checkout's objects, reading no global or system git config), so hooks and config the agent writes never run with the token. The token goes in an `Authorization` header set through that `git` child's own environment, scoped to the GitHub server, and is scrubbed from what the tool returns.

`GITHUB_API_URL` (default `https://api.github.com`) and `GITHUB_SERVER_URL` (default `https://github.com`) in the host's environment point it at GitHub Enterprise. The agent can't change them, so it can't send the token anywhere else.

To try it, copy this directory to `~/.pinomad/plugins/github/` and set `github_token` (see [Plugins](https://pinomad.si/docs/plugins/)). A fine-grained token needs Contents and Pull requests, read and write.

`apps/host/test/plugin-secrets.test.ts` loads this directory against a local fake GitHub, so keep it passing when you change it.
