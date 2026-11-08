import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Item } from "@astryxdesign/core/Item";
import { HStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useState } from "react";
import type { AccountError, AccountHostMatch } from "@pinomad/client/account.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountState } from "../../entities/account/account-model.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { RemoveHostDialog } from "./remove-host.tsx";

type SignedIn = Extract<AccountState, { status: "signed-in" }>;

/**
 * Pairing through the account, shared by every row that offers it: one
 * pairing at a time, its failure said once, and the paired host focused.
 */
export interface AccountPairing {
  /** The account hostId being paired right now. */
  readonly pairing: string | undefined;
  readonly error: AccountError | undefined;
  pair(hostId: string): void;
  retrySave(host: StoredHost): void;
}

export function useAccountPairing(): AccountPairing {
  const account = useAccountModel();
  const { focusHost } = useHosts();
  const [pairing, setPairing] = useState<string>();
  const [error, setError] = useState<AccountError>();
  return {
    pairing,
    error,
    pair: (hostId) => {
      setPairing(hostId);
      setError(undefined);
      void account.pairHost(hostId).then((result) => {
        setPairing(undefined);
        if (result.ok) focusHost(result.value.hostKey);
        else setError(result.error);
      });
    },
    // A saved retry finishes what Pair started: focus the host, no reload.
    retrySave: (host) => {
      setError(undefined);
      void account.retryUnsavedHost(host.account?.hostId).then((result) => {
        if (result.ok) focusHost(host.hostKey);
        else setError(result.error);
      });
    },
  };
}

/**
 * What the account says about a host paired here that needs the user:
 * it refused this device, or its key changed. Both wait for an explicit
 * Pair again (ADR-0022 §6): the model never asks for an invite on its own.
 */
export type AccountHostIssue = { readonly match: AccountHostMatch; readonly kind: "refused" | "key_changed" };

export function accountHostIssue(state: AccountState, hostKey: string): AccountHostIssue | undefined {
  if (state.status !== "signed-in") return undefined;
  const match = state.hosts.find((each) => each.stored?.hostKey === hostKey);
  if (match === undefined) return undefined;
  if (state.rejectedHostKeys.includes(hostKey)) return { match, kind: "refused" };
  if (match.status === "key_changed") return { match, kind: "key_changed" };
  return undefined;
}

export const ACCOUNT_HOST_ISSUE: Record<AccountHostIssue["kind"], string> = {
  refused: "This host refused this device.",
  key_changed: "The host's identity changed. Pair again only if you reinstalled it.",
};

/**
 * The account's hosts this device hasn't paired, against the current local
 * list: a match keeps the verdict of the last refresh, so a host unpaired
 * here since then still reads `paired` until the next one.
 */
export function unpairedAccountHosts(state: SignedIn, pairedHere: readonly StoredHost[]): readonly AccountHostMatch[] {
  const here = new Set(pairedHere.map((host) => host.hostKey));
  return state.hosts.filter((match) => match.stored === undefined || !here.has(match.stored.hostKey));
}

/** Why a host can't be paired right now, from the server's verdict. */
const UNPAIRABLE: Record<Exclude<AccountHostMatch["host"]["pairing"], "available">, string> = {
  offline: "Offline",
  host_too_old: "Needs pinomad upgrade",
  key_mismatch: "Run pinomad join again",
};

/**
 * Pairing that didn't finish: a pairing whose save failed (the key dies with
 * the page if it isn't kept), the last refresh's failure, and a failed Pair.
 */
export function AccountPairingBanners({ state, pairing }: { state: SignedIn; pairing: AccountPairing }) {
  const account = useAccountModel();
  return (
    <>
      {state.unsavedHosts.map((host) => (
        <Banner
          key={host.hostKey}
          status="warning"
          title="This pairing wasn't saved"
          description={`${host.name ?? host.url} will be lost when the app restarts.`}
          endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => pairing.retrySave(host)} />}
        />
      ))}
      {state.hostsError === undefined ? null : (
        <Banner
          status="warning"
          title="Couldn't refresh hosts"
          description={accountErrorMessage(state.hostsError)}
          endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => void account.refreshHosts()} />}
        />
      )}
      {pairing.error === undefined ? null : (
        <Banner status="error" title="Couldn't pair" description={accountErrorMessage(pairing.error)} />
      )}
    </>
  );
}

/**
 * The account's hosts that aren't paired here, each with Pair where the
 * server says it can reach it, and Remove from account in its menu (#512).
 */
export function AccountHostList({
  state,
  hosts,
  pairing,
  label,
}: {
  state: SignedIn;
  hosts: readonly AccountHostMatch[];
  pairing: AccountPairing;
  label: string;
}) {
  const now = useNow(30_000);
  const [removing, setRemoving] = useState<AccountHostMatch["host"]>();
  const account = useAccountModel();
  return (
    <>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
        {hosts.map(({ host }) => {
          const presence = host.online ? "Online" : `Last seen ${relativeTime(host.lastSeenAt, now)}`;
          const pairable = host.pairing === "available";
          return (
            <li key={host.hostId}>
              <Item
                as="div"
                density="compact"
                startContent={
                  <span aria-hidden="true" className="inline-flex">
                    <StatusDot variant={host.online ? "success" : "neutral"} label={host.online ? "Online" : "Offline"} />
                  </span>
                }
                label={host.name}
                descriptionLines={2}
                description={pairable ? presence : `${presence} · ${UNPAIRABLE[host.pairing as keyof typeof UNPAIRABLE]}`}
                endContent={
                  <HStack gap={1} vAlign="center">
                    {pairable ? (
                      <Button
                        label="Pair"
                        variant="secondary"
                        size="sm"
                        isLoading={pairing.pairing === host.hostId}
                        isDisabled={pairing.pairing !== undefined}
                        onClick={() => pairing.pair(host.hostId)}
                      />
                    ) : null}
                    <MoreMenu
                      label={`More for ${host.name}`}
                      size="sm"
                      isDisabled={removing !== undefined || pairing.pairing === host.hostId}
                      items={[{ label: "Remove from account…", onClick: () => setRemoving(host) }]}
                    />
                  </HStack>
                }
              />
            </li>
          );
        })}
      </ul>
      {removing === undefined ? null : (
        <RemoveHostDialog
          account={account}
          hostId={removing.hostId}
          name={removing.name}
          serverOrigin={state.serverOrigin}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </>
  );
}
