// `read` returns image files as image blocks; a configured processor shrinks
// them to the model's limits instead of refusing the file.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { isBusy, transcript } from "@pinomad/protocol/transcript.ts";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCoding } from "../src/extensions/coding.ts";
import { connectTo, imageSize, inlineImages, solidPng, startConversation, startFauxHost, tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();

describe("read images", () => {
  it("returns a PNG bigger than the model's limits resized to fit", async () => {
    const project = await tempDir();
    defer(project.remove);
    await writeFile(join(project.path, "big.png"), solidPng(3000, 1000, [200, 40, 40]));
    // No worker thread under vitest: Photon runs inline here.
    const images = await createNodePhotonImages({ worker: false });
    const host = await startFauxHost(defer, {
      dataDir: project.path,
      projects: [project.path],
      extensions: () => [createCoding({ images })],
      answers: [
        fauxAssistantMessage(fauxToolCall("read", { path: "big.png" }), { stopReason: "toolUse" }),
        "done",
      ],
    });
    const client = await connectTo(defer, host);
    await startConversation(client, { kind: "project", path: project.path }, "look at the png");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation!) && transcript(view.conversation!).at(-1)?.text === "done",
    );

    const result = client.view
      .current()
      .conversation!.entries.filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => entry.model?.[0] as { content?: unknown[]; isError?: boolean })
      .at(-1);
    expect(result?.isError).not.toBe(true);
    // The shared client subscribes with refs on 5.15; resolve them to bytes.
    const content = Array.isArray(result?.content) ? await inlineImages(client, result.content) : undefined;
    const image = content?.find((block) => (block as { type?: string }).type === "image") as
      | { data?: string; mimeType?: string }
      | undefined;
    expect(image?.mimeType).toMatch(/^image\//);
    const size = imageSize(Buffer.from(image?.data ?? "", "base64"));
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2000);
    // The long side is used fully: 3000x1000 becomes 2000 wide, not smaller.
    expect(Math.max(size.width, size.height)).toBeGreaterThanOrEqual(1500);
  });
});
