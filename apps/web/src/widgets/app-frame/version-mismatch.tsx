import { Banner } from "@astryxdesign/core/Banner";
import { VStack } from "@astryxdesign/core/Layout";
import { useEffect, useState } from "react";
import type { ProtocolMismatch } from "@pinomad/protocol/view.ts";
import { servedByHost } from "../../address.ts";
import { useAppUpdate } from "../../entities/app-update/use-app-update.ts";
import { UpdateStatusNote } from "../../entities/app-update/update-status-note.tsx";

const RELOADED_KEY = "pinomad.reloadedForProtocol";

/** The reload-once guard is per host: one outdated host must not trip another. */
export function reloadedKey(hostKey: string | undefined): string {
  return hostKey === undefined ? RELOADED_KEY : `${RELOADED_KEY}.${hostKey}`;
}

/**
 * The host speaks a protocol this bundle doesn't. A page the host itself
 * serves reloads once to fetch the matching bundle — the per-host
 * sessionStorage marker is the loop guard (a still-mismatching reload shows
 * the banner); a successful connect clears it so the next upgrade reloads.
 */
export function VersionMismatch({
  wsUrl,
  mismatch,
  hostKey,
}: {
  wsUrl: string;
  mismatch: ProtocolMismatch;
  /** The paired host whose reload marker this is; absent for token clients. */
  hostKey?: string;
}) {
  const marker = reloadedKey(hostKey);
  const update = useAppUpdate();
  const hasUpdater = window.pinomadDesktop?.updates !== undefined;
  const [reloading] = useState(() => {
    // The desktop bundle is local: a reload cannot fetch a newer client, so a
    // client-older host triggers an update check below instead. The browser
    // keeps the reload-once self-heal for pages the host itself served.
    if (mismatch.direction === "client-older" && hasUpdater) return false;
    if (!servedByHost(wsUrl, window.location)) return false;
    if (sessionStorage.getItem(marker) === String(mismatch.hostMajor)) return false;
    sessionStorage.setItem(marker, String(mismatch.hostMajor));
    window.location.reload();
    return true;
  });
  useEffect(() => {
    // check() itself dedupes an in-flight check or a finished download.
    if (mismatch.direction === "client-older") void window.pinomadDesktop?.updates?.check();
  }, [mismatch.direction]);
  if (reloading) return null;
  const version = mismatch.hostVersion === undefined ? "" : ` Host version: ${mismatch.hostVersion}.`;
  return mismatch.direction === "client-older" ? (
    // Same gap the Centered screens use between the banner and the switcher.
    <VStack gap={4}>
      <Banner
        status="error"
        container="section"
        title="Client out of date"
        description={`The host speaks a newer protocol. ${hasUpdater ? "Update the app." : "Reload the page, or update the app."}${version}`}
      />
      {hasUpdater ? <UpdateStatusNote update={update} /> : null}
    </VStack>
  ) : (
    <Banner
      status="error"
      container="section"
      title="Host out of date"
      description={`This client speaks a newer protocol. Upgrade the host (pinomad upgrade).${version}`}
    />
  );
}
