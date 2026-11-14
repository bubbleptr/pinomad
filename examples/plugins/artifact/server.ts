// Host half of the artifact example: a tool the model calls to write a page,
// and a method the panel calls to read it back.
import { definePlugin } from "@pinomad/plugin/v1";

export default definePlugin((pinomad) => {
  // The page can be large, so it stays on the host; the panel fetches it with `read`.
  const page = pinomad.state("page", { version: 1, shared: false, initial: () => ({ title: "", html: "" }) });
  // Synced to clients: tells the panel that there is a new page to fetch.
  const current = pinomad.state("current", { version: 1, initial: () => ({ title: "", revision: 0 }) });

  pinomad.tool({
    name: "artifact_write",
    description:
      "Show a page to the user in the side panel. `html` is a whole HTML document; its scripts run. " +
      "Put all CSS and JavaScript inline: external files and network requests are blocked, images only load from data: URLs. " +
      "Each call replaces the previous page, so always send the full document.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short name for the page." },
        html: { type: "string", description: "The whole HTML document." },
      },
      required: ["title", "html"],
    },
    run: async (args, ctx) => {
      const title = String(args.title);
      const html = String(args.html);
      await ctx.change(async (tx) => {
        Object.assign(await tx.get(page), { title, html });
        const shown = await tx.get(current);
        shown.title = title;
        shown.revision += 1;
      });
      return { text: `Showing "${title}" in the side panel.` };
    },
  });

  pinomad.method("read", async (_args, ctx) => ctx.read(page));
});
