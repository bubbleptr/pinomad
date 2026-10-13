// Host folder paths for the project picker's breadcrumbs and Up navigation.
// Hosts are POSIX-only, so paths are `/`-separated — no platform separator.

/** Breadcrumb segments for a host folder: under `home` it starts at "~", otherwise at "/". Paths are POSIX. */
export function folderCrumbs(path: string, home: string): { label: string; path: string }[] {
  // A shared name prefix is not "under home" ("/Users/vx" vs home "/Users/v").
  const underHome = home !== "/" && (path === home || path.startsWith(`${home}/`));
  const root = underHome ? home : "/";
  const crumbs = [{ label: underHome ? "~" : "/", path: root }];
  let current = root === "/" ? "" : root;
  for (const segment of path.slice(root.length).split("/")) {
    if (segment === "") continue;
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** The folder one level up, or undefined at "/". */
export function parentFolder(path: string): string | undefined {
  if (path === "/") return undefined;
  const at = path.lastIndexOf("/");
  return at === 0 ? "/" : path.slice(0, at);
}
