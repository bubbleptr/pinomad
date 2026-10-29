import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Pi packages no manifest imports directly but the runtime needs at the same exact version. */
export const PI_TRANSITIVE = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
] as const;

export interface PiStack {
  readonly version: string;
  /** Every pi package the published tarball must name directly, with its exact version. */
  readonly packages: ReadonlyMap<string, string>;
}

/**
 * `npm i -g` ignores `overrides` and `npm-shrinkwrap.json` declared by the
 * installed package, and npm 12 drops shrinkwrap from tarballs, so the only
 * pin that survives is a direct exact dependency. Naming the whole stack
 * hoists one copy at apps/host's version; upstream ranges then dedupe to it.
 */
export async function hostPiStack(root: string): Promise<PiStack> {
  const manifest = JSON.parse(await readFile(join(root, "apps/host/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const direct = Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith("@earendil-works/"));
  if (direct.length === 0) throw new Error("apps/host has no @earendil-works dependencies");
  const versions = new Set(direct.map(([, range]) => range));
  if (versions.size !== 1) {
    throw new Error(`apps/host pins @earendil-works/* to different versions: ${[...versions].join(", ")}`);
  }
  const version = [...versions][0]!;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`apps/host must pin @earendil-works/* exactly, got ${version}`);
  }
  const packages = new Map(direct);
  for (const name of PI_TRANSITIVE) packages.set(name, version);
  return { version, packages };
}
