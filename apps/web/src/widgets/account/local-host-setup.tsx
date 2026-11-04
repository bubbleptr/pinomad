import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { useSetupRun, type MintToken } from "../../entities/local-host/setup-run.ts";
import type { LocalHostBridge } from "../../entities/local-host/use-local-host.ts";
import { accountErrorMessage } from "./account-error.ts";
import { joinCommand } from "./join-command.ts";

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
        <HStack>
          <Button label="Set up this Mac" variant="secondary" onClick={run} />
        </HStack>
      );
    case "installing":
      return (
        <VStack gap={2}>
          <Progress label="Installing PiNomad…" />
          <InstallLog lines={phase.lines} />
          <HStack>
            <Button label="Cancel" variant="secondary" size="sm" onClick={cancel} />
          </HStack>
        </VStack>
      );
    case "joining":
      return <Progress label="Adding this Mac to your account…" />;
    case "failed":
      return (
        <VStack gap={3}>
          <Banner
            status="error"
            title={phase.step === "install" ? "Couldn't install PiNomad" : "Couldn't add this Mac to your account"}
            description={phase.message}
            endContent={<Button label="Try again" variant="secondary" onClick={run} />}
          />
          <InstallLog lines={phase.lines} />
          <VStack gap={2}>
            <Text type="supporting">Or run it in your own terminal:</Text>
            {/* No language: shell highlighting splits the server address into colors. */}
            <CodeBlock code={joinCommand(serverOrigin)} hasCopyButton isWrapped width="100%" />
          </VStack>
        </VStack>
      );
  }
}

function Progress({ label }: { label: string }) {
  return (
    <HStack gap={2} vAlign="center">
      <Spinner size="sm" />
      <Text type="supporting">{label}</Text>
    </HStack>
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
