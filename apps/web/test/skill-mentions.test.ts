// The `$` skill-mention surface end to end (issue #143, #308): the menu groups
// a scope's Project/User skills, a pick inserts `$name ` as plain text and
// binds it (painted through the CSS Custom Highlight API) while a typed
// `$name` stays plain and unpainted, and the sent bubble marks only the
// picked mention and shows only the typed text though the host expanded the
// skill into the stored message (ADR-0028).
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { startFauxHost, tempDir, useCleanups } from "@pinomad/host/test/support.ts";
import { startWeb } from "./support.ts";

const defer = useCleanups();
const run = promisify(execFile);
const shotDir = process.env.SKILL_SHOT_DIR;

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

it("offers $name skills grouped by source, binds and paints a pick, and marks the sent bubble", async () => {
  const webOrigin = await startWeb(defer);
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

  // Narrowing filters the list; Enter inserts `$name ` as plain text, bound.
  await editable.pressSequentially("rev");
  await expect.poll(async () => menu.getByRole("option").count()).toBe(1);
  await editable.press("Enter");
  await expect.poll(async () => editable.textContent()).toBe("$review ");
  await expect.poll(() => highlightCount(page)).toBe(1);
  await shot(page, "02-picked-highlight");

  // A typed `$deploy` — a known name — stays plain and unpainted: it binds nothing.
  await page.keyboard.type("then $deploy");
  await page.keyboard.press("Escape");
  await expect.poll(async () => editable.textContent()).toBe("$review then $deploy");
  await expect.poll(() => highlightCount(page)).toBe(1);
  await shot(page, "03-typed-plain");

  await editable.press("Enter");
  const mark = page.locator("mark.chat-skill-mention");
  await mark.waitFor();
  expect(await mark.textContent()).toBe("$review");
  // Only the expanded skill is marked; the typed `$deploy` stays plain.
  await expect.poll(async () => mark.count()).toBe(1);
  // The host expanded `$review` into the stored message (ADR-0028); the
  // bubble still shows exactly what was typed.
  const bubble = page.locator('[data-slot="chat-message-user"] [data-slot="chat-message-bubble"]');
  expect((await bubble.textContent())?.trim()).toBe("$review then $deploy");
  await shot(page, "04-bubble-mark");

  // Dark theme reads the same tokens — one extra shot for the PR.
  await page.emulateMedia({ colorScheme: "dark" });
  await mark.waitFor();
  await shot(page, "05-bubble-dark");
});
