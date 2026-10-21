import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { UpdateStatusNote } from "../../entities/app-update/update-status-note.tsx";
import { useAppUpdate } from "../../entities/app-update/use-app-update.ts";

/**
 * Settings → Updates, desktop only: the app's version and the updater's live
 * state. This is where a downloaded update installs — the sidebar only marks
 * the Settings button.
 */
export function UpdatesSection() {
  const update = useAppUpdate();
  if (update === undefined) return null;
  return (
    <VStack gap={3}>
      <Text>{`PiNomad ${update.status.currentVersion}`}</Text>
      {update.status.state === "idle" ? (
        <div>
          <Button label="Check for updates" variant="secondary" onClick={() => update.check()} />
        </div>
      ) : (
        <UpdateStatusNote update={update} />
      )}
    </VStack>
  );
}
