// Keeps the Rust comparison vectors fresh (ADR-0024 §6): regenerate with
// PINOMAD_UPDATE_VECTORS=1 whenever the TS reference or the case list in
// rust-vectors.ts changes, and review the diff like any contract snapshot.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildVectors } from "./rust-vectors.ts";

const dir = fileURLToPath(new URL("./fixtures/rust-vectors/", import.meta.url));

describe("rust vectors", () => {
  it("fixtures match the TS reference output", async () => {
    const files = buildVectors();
    if (process.env.PINOMAD_UPDATE_VECTORS === "1") {
      await mkdir(dir, { recursive: true });
      for (const file of files) await writeFile(join(dir, `${file.name}.json`), file.text);
      return;
    }
    for (const file of files) {
      const committed = await readFile(join(dir, `${file.name}.json`), "utf8").catch(() => "<missing>");
      expect(committed, `${file.name}.json is stale — rerun with PINOMAD_UPDATE_VECTORS=1`).toBe(file.text);
    }
  });
});
