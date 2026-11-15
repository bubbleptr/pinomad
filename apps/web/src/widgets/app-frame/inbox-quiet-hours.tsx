// When the Inbox's `notify` pushes wait (ADR-0052 §4): one window for the
// whole host, in the host's local time. Questions are not held.
import { hostSupportsFeature } from "@pinomad/protocol/frames.ts";
import type { QuietHours } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Input } from "../../shared/ui/input.tsx";
import { SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
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

/** Hidden for hosts before 5.38, which refuse the key. */
export function InboxQuietHours({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const minor = view.host?.protocol.minor;
  const settings = view.settings;
  if (settings === null || minor === undefined || !hostSupportsFeature(minor, "inboxQuietHours")) return null;
  const quiet = settings.inboxQuietHours ?? null;
  const disabled = view.connection !== "connected";
  const save = (next: QuietHours | null): void => void remote.controller.updateSettings({ inboxQuietHours: next });
  const change = (end: "start" | "end", value: string): void => {
    const minutes = minutesOf(value);
    if (quiet === null || minutes === undefined) return;
    save({ ...quiet, [end]: minutes });
  };
  return (
    <SettingsGroup title="Inbox">
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
    </SettingsGroup>
  );
}
