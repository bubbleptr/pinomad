import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { writeOutput } from "./xterm-view.tsx";

function lines(screen: Terminal): string[] {
  const buffer = screen.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").filter(Boolean);
}

// xterm parses writes later, so a reset must travel with them: two replays
// back to back (a resubscribe, StrictMode's second mount) once drew both.
it("shows a replay once when a second one arrives before the first was parsed", async () => {
  const screen = new Terminal();
  writeOutput(screen, "first\r\n$ ", true);
  writeOutput(screen, "first\r\n$ ", true);
  writeOutput(screen, "ls\r\n", false);
  await new Promise<void>((resolve) => screen.write("", resolve));
  expect(lines(screen)).toEqual(["first", "$ ls"]);
  screen.dispose();
});
