// GitHub through tools that add the token in the host process (ADR-0052 §6):
// the agent asks for a PR, a comment or a push and never holds the token
// itself. GITHUB_API_URL and GITHUB_SERVER_URL in the host's environment point
// it at GitHub Enterprise (or a test server); the agent cannot pick the host
// the token is sent to.
import { execFile } from "node:child_process";
import { definePlugin, type JsonObject, type PluginContext } from "@pinomad/plugin/v1";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const apiBase = (): string => (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const serverBase = (): string => (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");

function repoOf(args: JsonObject): string {
  const repo = args.repo;
  if (typeof repo !== "string" || !REPO.test(repo)) throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo)}`);
  return repo;
}

function text(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export default definePlugin((pinomad) => {
  const tokenSecret = pinomad.secret("github_token", {
    description: "A GitHub token that can push to and open pull requests on your repositories (fine-grained: Contents and Pull requests, read and write).",
  });

  const token = async (ctx: PluginContext): Promise<string> => {
    const value = await ctx.secret(tokenSecret);
    if (value === undefined) throw new Error("The github plugin's github_token secret is not set. Ask the user to set it.");
    return value;
  };

  /** One REST call; resolves with the parsed JSON body of a 2xx answer. */
  const rest = async (value: string, method: string, path: string, body: JsonObject): Promise<JsonObject> => {
    const response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${value}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pinomad-github-plugin",
      },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => ({}))) as JsonObject;
    if (!response.ok) {
      const detail = typeof answer.message === "string" ? answer.message : response.statusText;
      throw new Error(`GitHub answered ${response.status}: ${detail}`);
    }
    return answer;
  };

  pinomad.tool({
    name: "github_open_pr",
    description:
      "Open a pull request on GitHub. Push the branch first with git_push; `gh` and `git push` have no credentials here.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'The repository, "owner/name".' },
        head: { type: "string", description: "The branch with the changes." },
        base: { type: "string", description: "The branch to merge into." },
        title: { type: "string" },
        body: { type: "string", description: "The description, in Markdown." },
        draft: { type: "boolean" },
      },
      required: ["repo", "head", "base", "title"],
    },
    run: async (args, ctx) => {
      const repo = repoOf(args);
      const pr = await rest(await token(ctx), "POST", `/repos/${repo}/pulls`, {
        title: text(args, "title"),
        head: text(args, "head"),
        base: text(args, "base"),
        body: typeof args.body === "string" ? args.body : "",
        draft: args.draft === true,
      });
      return { text: `Opened pull request #${String(pr.number)}: ${String(pr.html_url)}` };
    },
  });

  pinomad.tool({
    name: "github_comment",
    description: "Comment on a GitHub issue or pull request.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'The repository, "owner/name".' },
        number: { type: "integer", description: "The issue or pull request number." },
        body: { type: "string", description: "The comment, in Markdown." },
      },
      required: ["repo", "number", "body"],
    },
    run: async (args, ctx) => {
      const repo = repoOf(args);
      const number = args.number;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("number must be a positive integer");
      const comment = await rest(await token(ctx), "POST", `/repos/${repo}/issues/${number}/comments`, { body: text(args, "body") });
      return { text: `Commented: ${String(comment.html_url)}` };
    },
  });

  pinomad.tool({
    name: "git_push",
    description:
      "Push the conversation checkout's HEAD to a branch of a GitHub repository. Commit first; this is the only way to push here.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'The repository, "owner/name".' },
        branch: { type: "string", description: "The branch to create or update on GitHub." },
      },
      required: ["repo", "branch"],
    },
    run: async (args, ctx) => {
      const repo = repoOf(args);
      const branch = text(args, "branch");
      if (/[\s:]/.test(branch) || branch.startsWith("-")) throw new Error(`branch ${JSON.stringify(branch)} is not a branch name`);
      if (ctx.cwd === undefined) throw new Error("This conversation has no working directory to push from");
      const value = await token(ctx);
      const basic = Buffer.from(`x-access-token:${value}`).toString("base64");
      const server = serverBase();
      // The header goes in the child's own environment, not its arguments (`ps` shows those), and is scoped to
      // the GitHub server, so it is never sent to another host. Only what git needs is passed on: none of the
      // host's tracing variables, which would print the header.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${server}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      };
      const scrub = (output: string): string => output.replaceAll(value, "[redacted]").replaceAll(basic, "[redacted]");
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["push", `${server}/${repo}.git`, `HEAD:refs/heads/${branch}`],
          { cwd: ctx.cwd, env, timeout: 120_000 },
          (error, stdout, stderr) => {
            const printed = scrub(`${stdout}${stderr}`).trim();
            if (error === null) resolve(printed);
            else reject(new Error(`git push failed${printed === "" ? `: ${scrub(error.message)}` : `:\n${printed}`}`));
          },
        );
      });
      return { text: `Pushed HEAD to ${repo} ${branch}.${output === "" ? "" : `\n${output}`}` };
    },
  });
});
