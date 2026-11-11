import { Button } from "../../shared/ui/button.tsx";
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
    <div className="flex flex-col gap-3">
      <span className="text-sm/5">{`PiNomad ${update.status.currentVersion}`}</span>
      {update.status.state === "idle" ? (
        <div>
          <Button variant="secondary" onClick={() => update.check()}>Check for updates</Button>
        </div>
      ) : (
        <UpdateStatusNote update={update} />
      )}
    </div>
  );
}
