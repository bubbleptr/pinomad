import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { AppUpdate } from "./use-app-update.ts";

/** Live update status, desktop only: under the client-out-of-date banner and in Settings → Updates. */
export function UpdateStatusNote({ update }: { update: AppUpdate | undefined }) {
  if (update === undefined) return <Text type="supporting">Checking for updates…</Text>;
  const { status } = update;
  switch (status.state) {
    case "checking":
      return <Text type="supporting">Checking for updates…</Text>;
    case "available":
    case "downloading": {
      const percent = status.progressPercent === undefined ? "" : ` ${Math.round(status.progressPercent)}%`;
      return <Text type="supporting">{`Downloading PiNomad ${status.availableVersion ?? ""}…${percent}`}</Text>;
    }
    case "ready":
      return <Button label="Restart to update" variant="primary" onClick={() => update.install()} />;
    case "error":
      return (
        <HStack gap={2} vAlign="center">
          <Text type="supporting">{status.message}</Text>
          <Button label="Retry" variant="secondary" onClick={() => update.check()} />
        </HStack>
      );
    case "disabled":
      return <Text type="supporting">{status.reason ?? "Updates are unavailable in this build."}</Text>;
    default:
      return <Text type="supporting">{`PiNomad ${status.currentVersion} is up to date; no newer release found.`}</Text>;
  }
}
