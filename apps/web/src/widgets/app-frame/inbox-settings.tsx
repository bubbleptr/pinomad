// The host-wide Inbox settings: which models new intake and task
// conversations start on (5.40), and when `notify` pushes wait (ADR-0052 §4),
// one window in the host's local time. Questions are not held.
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { QuietHours } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ModelCombobox } from "../../entities/model/model-combobox.tsx";
import { Button } from "../../shared/ui/button.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { GROUP_ROWS, SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { Switch } from "../../shared/ui/switch.tsx";

/** A fresh window: overnight. */
const DEFAULT_QUIET_HOURS: QuietHours = { start: 22 * 60, end: 8 * 60 };

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const minutesOf = (value: string): number | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < 1440 ? minutes : undefined;
};

/** Hidden for hosts before 5.38, which refuse the keys; the model rows need 5.40. */
export function InboxSettings({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const minor = view.host?.protocol.minor;
  const settings = view.settings;
  if (settings === null || minor === undefined || !hostSupportsFeature(minor, "inboxQuietHours")) return null;
  const models = hostSupportsFeature(minor, "inboxModels");
  const quiet = settings.inboxQuietHours ?? null;
  const disabled = view.connection !== "connected";
  const save = (next: QuietHours | null): void => void remote.controller.updateSettings({ inboxQuietHours: next });
  const change = (end: "start" | "end", value: string): void => {
    const minutes = minutesOf(value);
    if (quiet === null || minutes === undefined) return;
    save({ ...quiet, [end]: minutes });
  };
  const customModels = settings.custom.includes("inboxIntakeModel") || settings.custom.includes("inboxWorkerModel");
  return (
    <SettingsGroup title="Inbox">
      <div className={GROUP_ROWS}>
        <SettingsRow label="Quiet hours" description="Inbox updates wait until the window ends. Times are the host's local time.">
          {quiet === null ? null : (
            <>
              <Input
                type="time"
                aria-label="Quiet hours start"
                className="w-28"
                value={clock(quiet.start)}
                disabled={disabled}
                onChange={(event) => change("start", event.target.value)}
              />
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                to
              </span>
              <Input
                type="time"
                aria-label="Quiet hours end"
                className="w-28"
                value={clock(quiet.end)}
                disabled={disabled}
                onChange={(event) => change("end", event.target.value)}
              />
            </>
          )}
          <Switch
            aria-label="Quiet hours"
            checked={quiet !== null}
            disabled={disabled}
            onCheckedChange={(checked) => save(checked ? DEFAULT_QUIET_HOURS : null)}
          />
        </SettingsRow>
        {models ? (
          <>
            <SettingsRow label="Intake model" description="New intake conversations, where you hand work to the Inbox, start on this model">
              <ModelCombobox
                label="Intake model"
                models={view.models}
                value={settings.inboxIntakeModel ?? null}
                placeholder="Default model"
                disabled={disabled}
                onChange={(picked) => void remote.controller.updateSettings({ inboxIntakeModel: picked })}
              />
            </SettingsRow>
            <SettingsRow label="Worker model" description="New task conversations start on this model">
              <ModelCombobox
                label="Worker model"
                models={view.models}
                value={settings.inboxWorkerModel ?? null}
                placeholder="Default model"
                disabled={disabled}
                onChange={(picked) => void remote.controller.updateSettings({ inboxWorkerModel: picked })}
              />
            </SettingsRow>
          </>
        ) : null}
        {customModels ? (
          <div className="flex justify-end px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => void remote.controller.updateSettings({ inboxIntakeModel: null, inboxWorkerModel: null })}
            >
              Use the default model
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
