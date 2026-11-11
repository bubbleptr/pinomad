import { Button } from "../../shared/ui/button.tsx";
import { CodeBlock } from "@/shared/ui/code-block/code-block";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { useSetupRun, type MintToken } from "../../entities/local-host/setup-run.ts";
import type { LocalHostBridge } from "../../entities/local-host/use-local-host.ts";
import { accountErrorMessage } from "./account-error.ts";
import { joinCommand } from "./join-command.ts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

/** The installer's last lines: where it is, without a log to scroll. */
const SHOWN_LINES = 6;

/**
 * Sets up the host on this Mac without Terminal (#501): install.sh runs in
 * the background, then the host joins this account with a one-time token,
 * so there's no code to type. `onFinished` runs in every view showing the
 * setup once it joins, to re-read the host until launchd has it running.
 */
export function LocalHostSetup({
  bridge,
  serverOrigin,
  onFinished,
}: {
  bridge: LocalHostBridge;
  serverOrigin: string;
  onFinished: () => void;
}) {
  const account = useAccountModel();
  const { phase, finished, start, cancel } = useSetupRun(bridge);
  // Joined: the host is installed and starting, and this view goes once a re-read sees it.
  const [starting, setStarting] = useState(false);
  const seen = useRef(finished);
  useEffect(() => {
    if (finished === seen.current) return;
    seen.current = finished;
    setStarting(true);
    onFinished();
  }, [finished, onFinished]);

  const mintToken: MintToken = async () => {
    const result = await account.createJoinToken();
    return result.ok ? { ok: true, token: result.value.token } : { ok: false, message: accountErrorMessage(result.error) };
  };
  const run = (): void => start(serverOrigin, mintToken);

  switch (phase.kind) {
    case "idle":
      return starting ? (
        <Progress label="Starting the host…" />
      ) : (
        <div className="flex">
          <Button variant="secondary" onClick={run}>Set up this Mac</Button>
        </div>
      );
    case "installing":
      return (
        <div className="flex flex-col gap-2">
          <Progress label="Installing PiNomad…" />
          <InstallLog lines={phase.lines} />
          <div className="flex">
            <Button variant="secondary" size="sm" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      );
    case "joining":
      return <Progress label="Adding this Mac to your account…" />;
    case "failed":
      return (
        <div className="flex flex-col gap-3">
          <Alert variant="destructive">
            <AlertTitle>{phase.step === "install" ? "Couldn't install PiNomad" : "Couldn't add this Mac to your account"}</AlertTitle>
            <AlertDescription>{phase.message}</AlertDescription>
            <AlertAction><Button variant="secondary" onClick={run}>Try again</Button></AlertAction>
          </Alert>
          <InstallLog lines={phase.lines} />
          <div className="flex flex-col gap-2">
            <span className="text-xs/5 text-muted-foreground">Or run it in your own terminal:</span>
            {/* No language: shell highlighting splits the server address into colors. */}
            <CodeBlock code={joinCommand(serverOrigin)} hasCopyButton isWrapped width="100%" />
          </div>
        </div>
      );
  }
}

function Progress({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Spinner size="sm" />
      <span className="text-xs/5 text-muted-foreground">{label}</span>
    </div>
  );
}

const LOG: CSSProperties = {
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-sm)",
  color: "var(--color-text-secondary)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function InstallLog({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="log" aria-label="Install progress" style={LOG}>
      {lines.slice(-SHOWN_LINES).map((line, index) => (
        // The line's place in the whole log: it keeps its key as older ones drop off.
        <div key={Math.max(0, lines.length - SHOWN_LINES) + index}>{line}</div>
      ))}
    </div>
  );
}
