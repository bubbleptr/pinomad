# github

An example PiNomad plugin that keeps a credential out of the agent's hands (ADR-0052 §6). The agent calls `github_open_pr`, `github_comment` and `git_push`; the plugin adds the `github_token` secret in the host process, so the token is never in the conversation, a tool result or the agent's environment. The agent still runs as the same user as the host, so it is not out of reach of the agent's commands: `gh` or `git push` may work with your own logins, and the host's `secrets.json` is readable by that user.

- `package.json`: the plugin's name.
- `server.ts`: the secret and the three tools. `git_push` pushes the conversation checkout's `HEAD` to a branch. It reads the commit from the checkout without the token, then pushes from a scratch repository the host makes (borrowing the checkout's objects, reading no global or system git config), so hooks and config the agent writes never run with the token. The token goes in an `Authorization` header set through that `git` child's own environment, scoped to the GitHub server, and is scrubbed from what the tool returns.

It also declares three Inbox event sources (ADR-0051 §10), polled with the same token: `issues` (new open issues of `owner/repo`, filtered with `label:<name>`), and `pr-comments` and `ci` (comments on pull requests and finished workflow runs of `owner/repo`), which are `followedOnly`: they only reach a task that follows the PR. Each first poll only marks where it starts. Their threads are `github:owner/repo#<number>`. For them the token also needs Issues, Pull requests and Actions read access.

`GITHUB_API_URL` (default `https://api.github.com`) and `GITHUB_SERVER_URL` (default `https://github.com`) in the host's environment point it at GitHub Enterprise. The agent can't change them through these tools, so the tools never send the token anywhere else.

To try it, copy this directory to `~/.pinomad/plugins/github/` and set `github_token` (see [Plugins](https://pinomad.si/docs/plugins/)). A fine-grained token needs Contents and Pull requests, read and write.

`apps/host/test/plugin-secrets.test.ts` and `apps/host/test/inbox-sources.test.ts` load this directory against a local fake GitHub, so keep them passing when you change it.
