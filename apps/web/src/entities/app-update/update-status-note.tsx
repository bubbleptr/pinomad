import { Button } from "@astryxdesign/core/Button";
import type { AppUpdate } from "./use-app-update.ts";

/** Live update status, desktop only: under the client-out-of-date banner and in Settings → Updates. */
export function UpdateStatusNote({ update }: { update: AppUpdate | undefined }) {
  if (update === undefined) return <span className="text-xs/5 text-muted-foreground">Checking for updates…</span>;
  const { status } = update;
  switch (status.state) {
    case "checking":
      return <span className="text-xs/5 text-muted-foreground">Checking for updates…</span>;
    case "available":
    case "downloading": {
      const percent = status.progressPercent === undefined ? "" : ` ${Math.round(status.progressPercent)}%`;
      return <span className="text-xs/5 text-muted-foreground tabular-nums">{`Downloading PiNomad ${status.availableVersion ?? ""}…${percent}`}</span>;
    }
    case "ready":
      return <Button label="Restart to update" variant="primary" onClick={() => update.install()} />;
    case "error":
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs/5 text-muted-foreground">{status.message}</span>
          <Button label="Retry" variant="secondary" onClick={() => update.check()} />
        </div>
      );
    case "disabled":
      return <span className="text-xs/5 text-muted-foreground">{status.reason ?? "Updates are unavailable in this build."}</span>;
    default:
      return <span className="text-xs/5 text-muted-foreground">{`PiNomad ${status.currentVersion} is up to date; no newer release found.`}</span>;
  }
}
