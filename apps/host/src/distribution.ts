// The single source/packaged switch (ADR-0016): the npm bundle defines
// PINOMAD_VERSION at build time; a source checkout leaves it undeclared, and
// `typeof` tells the two apart. Everything that differs between the published
// package and a checkout — web root, service entry, command spellings — is
// decided here so the rest of the code doesn't care.

import { fileURLToPath } from "node:url";

// Bundled builds (apps/cli/build.ts) define PINOMAD_VERSION; a source checkout leaves it undeclared.
declare const PINOMAD_VERSION: string | undefined;

/** The release version, or undefined in a source checkout. */
export const packagedVersion: string | undefined = typeof PINOMAD_VERSION === "string" ? PINOMAD_VERSION : undefined;

// Built web client: <pkg>/web next to the bundle's flat dist/, or the checkout's apps/web/dist.
export const webRoot = fileURLToPath(new URL(packagedVersion === undefined ? "../../web/dist" : "../web/", import.meta.url));

// What the service runs: the bundle entry with `host`, or the checkout's main.ts.
export const hostEntry: { readonly script: string; readonly args: readonly string[] } =
  packagedVersion === undefined
    ? { script: fileURLToPath(new URL("./main.ts", import.meta.url)), args: [] }
    : { script: fileURLToPath(new URL("./pinomad.js", import.meta.url)), args: ["host"] };

/** How to spell a subcommand in user-facing hints: `pinomad pair` vs `bun run pair`. */
export const commandHint = (name: string): string => (packagedVersion === undefined ? `bun run ${name}` : `pinomad ${name}`);
