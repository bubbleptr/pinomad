/**
 * Install pinomad with its own Node (#499), and the script then runs `pinomad
 * up` (#498), which asks for a code to confirm (#495). The script runs it, not
 * a second line: this terminal's PATH doesn't have ~/.local/bin yet on a new
 * Mac. `--origin` always: up otherwise keeps a host on the server it already
 * joined.
 */
export const joinCommand = (serverOrigin: string): string =>
  `curl -fsSL https://pinomad.si/install.sh | sh -s -- up --origin ${serverOrigin.replace(/\/+$/, "")}`;
