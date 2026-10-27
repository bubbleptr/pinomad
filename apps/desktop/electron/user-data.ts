import { basename, dirname, join } from "node:path";

/**
 * An unpackaged build must not share userData with the installed app: it would
 * rewrite the real host list and renderer localStorage while debugging. A
 * sibling keeps both editions side by side, and the override still lets E2E
 * point the app at a throwaway directory.
 */
export function desktopUserDataDir(options: {
  defaultDir: string;
  isPackaged: boolean;
  override?: string;
}): string {
  if (options.override !== undefined) return options.override;
  if (options.isPackaged) return options.defaultDir;
  return join(dirname(options.defaultDir), `${basename(options.defaultDir)}-dev`);
}
