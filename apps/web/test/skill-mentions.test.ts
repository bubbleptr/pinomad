// The `$` skill-mention surface end to end (issue #143): the menu groups a
// scope's Project/User skills, `$name ` inserts as plain text, known names
// paint through the CSS Custom Highlight API while unmatched `$` stays plain,
// and the sent bubble marks the mention.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { freePort, startFauxHost, tempDir, useCleanups } from "@pinomad/host/test/support.ts";

const defer = useCleanups();
const run = promisify(execFile);
const webConfig = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const shotDir = process.env.SKILL_SHOT_DIR;

async function startWeb(): Promise<string> {
  const vite = await createServer({ configFile: webConfig, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  return new URL(vite.resolvedUrls!.local[0]!).origin;
}

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}.\n`;

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), SKILL(name, description));
}

/** A git project whose `.agents/skills` are committed — the worktree scope reads HEAD. */
async function initProject(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-C", path, "init", "-b", "main"]);
  await writeSkill(join(path, ".agents", "skills"), "review", "Project review steps");
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
}

const prompt = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "Prompt" }).or(page.getByRole("combobox", { name: "Prompt" }));

/** Highlight count registered under the shared name — 0 means no mention is painted. */
const highlightCount = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate((name) => CSS.highlights.get(name)?.size ?? 0, "pinomad-skill-mention");

async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (shotDir === undefined) return;
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: false });
}

it("offers $name skills grouped by source, highlights them, and marks the sent bubble", async () => {
  const webOrigin = await startWeb();
  const dir = await tempDir();
  defer(dir.remove);
  const project = await tempDir();
  defer(project.remove);
  const agentsHome = await tempDir();
  defer(agentsHome.remove);
  await initProject(project.path);
  await writeSkill(join(agentsHome.path, "skills"), "deploy", "User deploy steps");
  const host = await startFauxHost(defer, {
    browserOrigins: [webOrigin],
    dataDir: dir.path,
    projects: [project.path],
    agentsHome: agentsHome.path,
  });
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  await page.goto(`${webOrigin}/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await prompt(page).waitFor();

  // The draft picks the project — a worktree checkout, so only the committed
  // `review` is offerable next to the user's `deploy`.
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: basename(project.path) }).click();

  const editable = page.getByRole("combobox", { name: "Prompt" });
  await editable.click();
  await editable.pressSequentially("$");
  const menu = page.getByRole("listbox", { name: "Skills" });
  await menu.waitFor();
  await menu.getByRole("option", { name: /review/ }).waitFor();
  // One headed group per entry: the project's skills, then the user's.
  await menu.getByText("Project", { exact: true }).waitFor();
  await menu.getByText("User", { exact: true }).waitFor();
  await menu.getByRole("option", { name: /deploy/ }).waitFor();
  await shot(page, "01-menu-groups");

  // Narrowing filters the list; Enter inserts `$name ` as plain text.
  await editable.pressSequentially("rev");
  await expect.poll(async () => menu.getByRole("option").count()).toBe(1);
  await editable.press("Enter");
  await expect.poll(async () => editable.textContent()).toBe("$review ");
  await expect.poll(() => highlightCount(page)).toBe(1);
  await shot(page, "02-matched-highlight");

  // An unknown name paints nothing; the known one keeps its highlight.
  await editable.pressSequentially("then $nope");
  await expect.poll(() => highlightCount(page)).toBe(1);
  await shot(page, "03-unmatched-plain");

  await editable.press("Enter");
  const mark = page.locator("mark.chat-skill-mention");
  await mark.waitFor();
  expect(await mark.textContent()).toBe("$review");
  // The unknown name stays plain text in the bubble.
  await expect.poll(async () => mark.count()).toBe(1);
  await shot(page, "04-bubble-mark");
});
