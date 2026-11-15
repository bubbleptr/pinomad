// GitHub through tools that add the token in the host process (ADR-0052 §6):
// the agent asks for a PR, a comment or a push and the token is never in its
// conversation or environment. It runs as the host's user, so this does not
// put the token out of its reach. GITHUB_API_URL and GITHUB_SERVER_URL in the
// host's environment point it at GitHub Enterprise (or a test server); the
// agent cannot pick through these tools the host the token is sent to.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type JsonObject, type PluginContext } from "@pinomad/plugin/v1";

/** "owner/name"; `.` and `..` are no names. */
const REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

const apiBase = (): string => (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const serverBase = (): string => (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");

/** The host's PATH, HOME, locale and proxy settings; none of its other variables, such as git's tracing ones, which print headers. */
function plainEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["HOME", "LANG", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** `plainEnv` reading no config but the repository's own: none from HOME, XDG or the system. */
function isolatedEnv(home: string): Record<string, string> {
  return { ...plainEnv(), HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

/** Runs git; resolves with what it printed, rejects with that as the message. */
function git(args: readonly string[], cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error === null) resolve({ stdout, stderr });
      else reject(new Error(`${stdout}${stderr}`.trim() || error.message));
    });
  });
}

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

  const token = async (ctx: Pick<PluginContext, "secret">): Promise<string> => {
    const value = await ctx.secret(tokenSecret);
    if (value === undefined) throw new Error("The github plugin's github_token secret is not set; set it in the plugin's settings.");
    return value;
  };

  /** One REST call; resolves with the parsed JSON body of a 2xx answer. A GET sends no body. */
  const rest = async <T = JsonObject>(value: string, method: string, path: string, body?: JsonObject): Promise<T> => {
    const response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${value}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pinomad-github-plugin",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => ({}))) as JsonObject;
    if (!response.ok) {
      const detail = typeof answer.message === "string" ? answer.message : response.statusText;
      throw new Error(`GitHub answered ${response.status}: ${detail}`);
    }
    return answer as T;
  };

  // Inbox event sources (ADR-0051 §10), polled with the same token. Each first
  // poll only marks where it starts, so adding a source does not flood the Inbox
  // with the backlog. Threads are `github:owner/repo#<number>`: an issue's task
  // gets its later events, and comments and CI results only reach a task that
  // follows the PR (the agent calls inbox_follow after opening one).
  const thread = (repo: string, number: number): string => `github:${repo}#${number}`;

  /** "owner/repo label:a label:b": the repository, then the labels an issue must all have. */
  const parseFilter = (filter: string): { repo: string; labels: string[] } => {
    const [repo = "", ...rest] = filter.trim().split(/\s+/);
    if (!REPO.test(repo)) throw new Error(`The filter must start with "owner/repo", got ${JSON.stringify(filter)}`);
    const labels = rest.map((part) => {
      if (!part.startsWith("label:") || part.length === "label:".length) throw new Error(`Only label:<name> may follow the repository, got ${JSON.stringify(part)}`);
      return part.slice("label:".length);
    });
    return { repo, labels };
  };

  type Issue = { number: number; title: string; html_url: string; labels: { name: string }[]; pull_request?: unknown };
  pinomad.source({
    name: "issues",
    description: "New issues",
    filter: "owner/repo, then label:<name> for each label an issue must have",
    poll: {
      run: async ({ cursor }, ctx) => {
        const { repo, labels } = parseFilter(ctx.filter);
        const query = new URLSearchParams({ state: "open", sort: "created", direction: "desc", per_page: "100" });
        if (labels.length > 0) query.set("labels", labels.join(","));
        // The issues endpoint lists pull requests too.
        const open = (await rest<Issue[]>(await token(ctx), "GET", `/repos/${repo}/issues?${query}`)).filter((issue) => issue.pull_request === undefined);
        const known = new Set(Array.isArray(cursor) ? cursor.filter((each): each is number => typeof each === "number") : []);
        const fresh = cursor === undefined ? [] : open.filter((issue) => !known.has(issue.number)).reverse();
        return {
          events: fresh.map((issue) => ({
            id: `issue:${issue.number}`,
            thread: thread(repo, issue.number),
            title: `#${issue.number} ${issue.title}`.slice(0, 120),
            summary: `New issue #${issue.number} in ${repo}: ${issue.title}\n${issue.html_url}`,
          })),
          // The newest few hundred numbers: enough to tell new from seen; the host drops repeats anyway.
          cursor: [...new Set([...open.map((issue) => issue.number), ...known])].slice(0, 500),
        };
      },
    },
  });

  type Comment = { id: number; html_url: string; created_at: string; user?: { login?: string }; issue_url?: string; pull_request_url?: string };
  pinomad.source({
    name: "pr-comments",
    description: "Comments on pull requests a task follows",
    filter: "owner/repo",
    followedOnly: true,
    poll: {
      run: async ({ cursor }, ctx) => {
        const { repo } = parseFilter(ctx.filter);
        const since = typeof cursor === "string" ? cursor : new Date().toISOString();
        if (cursor === undefined) return { events: [], cursor: since };
        const value = await token(ctx);
        const query = new URLSearchParams({ since, sort: "created", direction: "asc", per_page: "100" });
        // Conversation comments (on the issues endpoint, PRs among them) and review comments on the diff.
        const comments = [
          ...(await rest<Comment[]>(value, "GET", `/repos/${repo}/issues/comments?${query}`)).filter((each) => each.html_url.includes("/pull/")),
          ...(await rest<Comment[]>(value, "GET", `/repos/${repo}/pulls/comments?${query}`)),
        ].filter((each) => each.created_at > since);
        const events = comments.flatMap((comment) => {
          const number = Number(/\/(\d+)$/.exec(comment.pull_request_url ?? comment.issue_url ?? "")?.[1]);
          if (!Number.isSafeInteger(number)) return [];
          return [{
            id: `comment:${comment.id}`,
            thread: thread(repo, number),
            summary: `${comment.user?.login ?? "Someone"} commented on #${number} in ${repo}\n${comment.html_url}`,
          }];
        });
        const latest = comments.reduce((at, comment) => (comment.created_at > at ? comment.created_at : at), since);
        return { events, cursor: latest };
      },
    },
  });

  type Run = { id: number; run_attempt?: number; name?: string; conclusion: string | null; html_url: string; updated_at: string; head_branch?: string; pull_requests?: { number: number }[] };
  pinomad.source({
    name: "ci",
    description: "CI results on pull requests a task follows",
    filter: "owner/repo",
    followedOnly: true,
    poll: {
      run: async ({ cursor }, ctx) => {
        const { repo } = parseFilter(ctx.filter);
        const query = new URLSearchParams({ status: "completed", per_page: "50" });
        const { workflow_runs: runs = [] } = await rest<{ workflow_runs?: Run[] }>(await token(ctx), "GET", `/repos/${repo}/actions/runs?${query}`);
        const latest = runs.reduce((at, run) => (run.updated_at > at ? run.updated_at : at), typeof cursor === "string" ? cursor : "");
        if (typeof cursor !== "string") return { events: [], cursor: latest || new Date().toISOString() };
        const events = runs
          .filter((run) => run.updated_at > cursor)
          .reverse()
          .flatMap((run) =>
            (run.pull_requests ?? []).map((pr) => ({
              id: `run:${run.id}:${run.run_attempt ?? 1}:${pr.number}`,
              thread: thread(repo, pr.number),
              summary: `CI ${run.name ?? "run"} ${run.conclusion ?? "finished"} on #${pr.number} in ${repo}\n${run.html_url}`,
            })),
          );
        return { events, cursor: latest };
      },
    },
  });

  pinomad.tool({
    name: "github_open_pr",
    description:
      "Open a pull request on GitHub. Push the branch first with git_push; use these tools rather than `gh` or `git push`.",
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
      "Push the conversation checkout's HEAD to a branch of a GitHub repository. Commit first; use this rather than `git push`.",
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
      const scrub = (output: string): string => output.replaceAll(value, "[redacted]").replaceAll(basic, "[redacted]");
      const server = serverBase();

      // Without the token: what to push, read from the agent's checkout.
      const commit = (await git(["rev-parse", "--verify", "HEAD^{commit}"], ctx.cwd, plainEnv())).stdout.trim();
      const objects = (await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], ctx.cwd, plainEnv())).stdout.trim();

      // With the token: a repository the host made, borrowing the checkout's objects. The agent writes the
      // checkout's hooks and config, so a git holding the token never runs there; it reads no global or
      // system config either, which the agent's shell could also write.
      const scratch = await mkdtemp(join(tmpdir(), "pinomad-push-"));
      try {
        await git(["init", "-q", "--bare", "--template=", scratch], scratch, isolatedEnv(scratch));
        await writeFile(join(scratch, "objects", "info", "alternates"), `${objects}\n`);
        // The header goes in the child's environment, not its arguments (`ps` shows those), scoped to the
        // GitHub server so it is never sent to another host.
        const env = {
          ...isolatedEnv(scratch),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${server}/.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        };
        const output = await git(["push", `${server}/${repo}.git`, `${commit}:refs/heads/${branch}`], scratch, env).catch((error: unknown) => {
          throw new Error(`git push failed:\n${scrub(error instanceof Error ? error.message : String(error))}`);
        });
        const printed = scrub(`${output.stdout}${output.stderr}`).trim();
        return { text: `Pushed HEAD to ${repo} ${branch}.${printed === "" ? "" : `\n${printed}`}` };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });
});
