import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useState } from "react";
import type { AccountError, AccountHostMatch, JoinToken } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { switchHost, useHosts } from "../../entities/host/host-store.ts";
import { useNow } from "../../shared/use-now.ts";

/** Server and model error codes in words. Unknown codes fall through to the raw code. */
export function accountErrorMessage(error: AccountError): string {
  switch (error.code) {
    case "invalid_credentials":
      return "Wrong username or password.";
    case "rate_limited":
      return "Too many attempts. Wait a few minutes and try again.";
    case "network":
      return "Can't reach the server. Check the address and your connection.";
    case "origin_required":
      return "Enter the server address.";
    case "insecure_origin":
      return "The server address must start with https://.";
    case "unauthenticated":
      return "You were signed out. Sign in again.";
    case "accounts_disabled":
      return "This server doesn't have accounts turned on.";
    case "host_offline":
      return "The host is offline.";
    case "host_too_old":
      return "The host needs an update (run pinomad upgrade on it).";
    case "key_mismatch":
      return "The host's key doesn't match its account record. Run pinomad join on it again.";
    case "disabled":
      return "The host doesn't accept account devices. Turn it on in Devices, or pair with a QR code.";
    case "not_joined":
    case "rebinding":
      return "The host is moving between servers. Try again after it restarts.";
    case "host_timeout":
      return "The host didn't answer in time. Try again.";
    case "pair_rejected":
      return "The host refused this device. If you revoked it before, pair it with a QR code instead.";
    case "pairing_not_saved":
      return "Paired, but this device couldn't save the pairing.";
    default:
      return `Something went wrong (${error.code}).`;
  }
}

/**
 * Sign in to the account server, see its hosts, pair or connect to them, and
 * add new ones (ADR-0022). Renders nothing where this client can't reach an
 * account API — a host's own port, a dev server.
 */
export function AccountPanel() {
  const account = useAccountModel();
  const { state } = account;
  // Lives here, not in SignedIn: a failed sign-out still lands signed-out,
  // and the warning has to survive that unmount.
  const [signOutWarning, setSignOutWarning] = useState<string>();
  switch (state.status) {
    case "unavailable":
      return null;
    case "checking":
      return (
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text type="supporting">Checking for an account…</Text>
        </HStack>
      );
    case "signed-out":
      return (
        <VStack gap={3} style={{ width: "100%" }}>
          {signOutWarning === undefined ? null : (
            <Banner status="warning" title="Sign-out not confirmed" description={signOutWarning} />
          )}
          <SignInForm account={account} state={state} />
        </VStack>
      );
    case "signed-in":
      return <SignedIn account={account} state={state} onSignOutWarning={setSignOutWarning} />;
  }
}

function SignInForm({ account, state }: { account: AccountModel; state: Extract<AccountState, { status: "signed-out" }> }) {
  // Bearer clients (desktop) pick their server; a cookie page is the server.
  const asksOrigin = state.mode === "bearer";
  const [origin, setOrigin] = useState(state.serverOrigin ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const ready = username.trim() !== "" && password !== "" && (!asksOrigin || origin.trim() !== "");
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    void account
      .login({ username: username.trim(), password, ...(asksOrigin ? { serverOrigin: origin.trim() } : {}) })
      .then((result) => {
        setBusy(false);
        if (!result.ok) setError(result.error);
      });
  };
  return (
    <VStack gap={3} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>Sign in</Heading>
        <Text type="supporting">See the hosts on your account and connect without a QR code.</Text>
      </VStack>
      {asksOrigin ? (
        <TextInput
          label="Server"
          placeholder="https://nomad.example.com"
          value={origin}
          onChange={setOrigin}
          onEnter={submit}
          width="100%"
        />
      ) : null}
      <TextInput label="Username" value={username} onChange={setUsername} onEnter={submit} width="100%" />
      <TextInput label="Password" type="password" value={password} onChange={setPassword} onEnter={submit} width="100%" />
      {error === undefined ? null : <Banner status="error" title="Couldn't sign in" description={accountErrorMessage(error)} />}
      <Button label="Sign in" variant="primary" isLoading={busy} isDisabled={!ready} onClick={submit} />
    </VStack>
  );
}

function SignedIn({
  account,
  state,
  onSignOutWarning,
}: {
  account: AccountModel;
  state: Extract<AccountState, { status: "signed-in" }>;
  onSignOutWarning: (message: string | undefined) => void;
}) {
  const [actionError, setActionError] = useState<AccountError>();
  const server = new URL(state.serverOrigin).host;
  // A saved retry finishes what Pair started: connect to the host.
  const retrySave = (host: StoredHost): void => {
    setActionError(undefined);
    void account.retryUnsavedHost().then((result) => {
      if (result.ok) switchHost(host.hostKey);
      else setActionError(result.error);
    });
  };
  return (
    <VStack gap={4} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>{state.user}</Heading>
        <Text type="supporting">Signed in to {server}</Text>
      </VStack>
      {state.unsavedHost === undefined ? null : (
        <Banner
          status="warning"
          title="This pairing wasn't saved"
          description="It will be lost when the app restarts."
          endContent={<Button label="Retry" variant="ghost" onClick={() => retrySave(state.unsavedHost!)} />}
        />
      )}
      <HostList account={account} state={state} onError={setActionError} />
      {actionError === undefined ? null : (
        <Banner status="error" title="Couldn't pair" description={accountErrorMessage(actionError)} />
      )}
      <AddHost account={account} />
      <SignOut account={account} onWarning={onSignOutWarning} />
    </VStack>
  );
}

function HostList({
  account,
  state,
  onError,
}: {
  account: AccountModel;
  state: Extract<AccountState, { status: "signed-in" }>;
  onError: (error: AccountError | undefined) => void;
}) {
  const now = useNow(30_000);
  const { activeHostKey } = useHosts();
  const [pairing, setPairing] = useState<string>();
  const pair = (hostId: string): void => {
    setPairing(hostId);
    onError(undefined);
    void account.pairHost(hostId).then((result) => {
      setPairing(undefined);
      // paired() already made it the active host; reload to connect.
      if (result.ok) switchHost(result.value.hostKey);
      else onError(result.error);
    });
  };
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text weight="semibold">Hosts</Text>
        <Button label="Refresh" variant="ghost" size="sm" onClick={() => void account.refreshHosts()} />
      </HStack>
      {state.hostsError === undefined ? null : (
        <Banner status="warning" title="Couldn't refresh hosts" description={accountErrorMessage(state.hostsError)} />
      )}
      {state.hosts.length === 0 ? (
        <Text type="supporting">No hosts yet. Add one below.</Text>
      ) : (
        <List density="compact">
          {state.hosts.map((match) => (
            <HostRow
              key={match.host.hostId}
              match={match}
              now={now}
              isCurrent={match.status === "paired" && match.stored?.hostKey === activeHostKey}
              isRevoked={match.stored !== undefined && state.rejectedHostKeys.includes(match.stored.hostKey)}
              isPairing={pairing === match.host.hostId}
              isBusy={pairing !== undefined}
              onPair={() => pair(match.host.hostId)}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

/** Why a host can't be paired right now, from the server's verdict. */
const UNPAIRABLE: Record<Exclude<AccountHostMatch["host"]["pairing"], "available">, string> = {
  offline: "Offline",
  host_too_old: "Needs pinomad upgrade",
  key_mismatch: "Run pinomad join again",
};

function HostRow({
  match,
  now,
  isCurrent,
  isRevoked,
  isPairing,
  isBusy,
  onPair,
}: {
  match: AccountHostMatch;
  now: number;
  isCurrent: boolean;
  isRevoked: boolean;
  isPairing: boolean;
  isBusy: boolean;
  onPair: () => void;
}) {
  const { host, status, stored } = match;
  const presence = host.online ? "Online" : `Last seen ${relativeTime(host.lastSeenAt, now)}`;
  const pairable = host.pairing === "available";
  const pairButton = (label: string) => (
    <Button label={label} variant="secondary" size="sm" isLoading={isPairing} isDisabled={!pairable || isBusy} onClick={onPair} />
  );
  // Revoked and key-changed both need the user's explicit re-pair (ADR-0022 §6):
  // the model never asks for an invite on its own.
  let detail: string = presence;
  let end;
  if (isRevoked) {
    detail = "This device was refused by the host";
    end = pairButton("Pair again");
  } else if (status === "key_changed") {
    detail = "The host's identity changed. Pair again only if you reinstalled it.";
    end = (
      <HStack gap={2} vAlign="center">
        <Token label="Key changed" color="orange" size="sm" />
        {pairButton("Pair again")}
      </HStack>
    );
  } else if (status === "paired") {
    end = isCurrent ? (
      <Token label="Connected" size="sm" />
    ) : (
      <Button label="Connect" variant="secondary" size="sm" onClick={() => switchHost(stored!.hostKey)} />
    );
  } else {
    if (!pairable) detail = `${presence} · ${UNPAIRABLE[host.pairing as keyof typeof UNPAIRABLE]}`;
    end = pairButton("Pair");
  }
  return (
    <ListItem
      label={host.name}
      description={detail}
      startContent={<StatusDot variant={host.online ? "success" : "neutral"} label={host.online ? "Online" : "Offline"} />}
      endContent={end}
    />
  );
}

/** "Add a host": a one-time `pinomad join` command to run on the new machine. */
function AddHost({ account }: { account: AccountModel }) {
  const [token, setToken] = useState<JoinToken>();
  const [error, setError] = useState<AccountError>();
  const [busy, setBusy] = useState(false);
  const create = (): void => {
    setBusy(true);
    setError(undefined);
    void account.createJoinToken().then((result) => {
      setBusy(false);
      if (result.ok) setToken(result.value);
      else setError(result.error);
    });
  };
  return (
    <VStack gap={2}>
      {token === undefined ? (
        <Button label="Add a host" variant="secondary" isLoading={busy} onClick={create} />
      ) : (
        <JoinCommand token={token} onRenew={create} onDone={() => {
          setToken(undefined);
          void account.refreshHosts();
        }} />
      )}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't create a join command" description={accountErrorMessage(error)} />
      )}
    </VStack>
  );
}

function JoinCommand({ token, onRenew, onDone }: { token: JoinToken; onRenew: () => void; onDone: () => void }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((token.expiresAt - now) / 1000));
  return (
    <VStack gap={2}>
      <Text weight="semibold">Add a host</Text>
      <Text type="supporting">Run this on the machine you want to add. It installs PiNomad and joins it to your account.</Text>
      {/* No language: shell highlighting splits the server address and token into colors. */}
      <CodeBlock code={token.command} hasCopyButton isWrapped />
      <HStack gap={2} vAlign="center" hAlign="between">
        {seconds === 0 ? (
          <HStack gap={2} vAlign="center">
            <Text type="supporting">Expired</Text>
            <Button label="New command" variant="secondary" size="sm" onClick={onRenew} />
          </HStack>
        ) : (
          <Text type="supporting">
            Works once · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </Text>
        )}
        <Button label="Done" variant="ghost" size="sm" onClick={onDone} />
      </HStack>
    </VStack>
  );
}

function SignOut({ account, onWarning }: { account: AccountModel; onWarning: (message: string | undefined) => void }) {
  // Signing out everywhere ends every session at once — one extra click to confirm.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <VStack gap={1}>
      <HStack gap={2}>
        <Button
          label="Sign out"
          variant="ghost"
          onClick={() => {
            onWarning(undefined);
            void account.logout().then((result) => {
              if (!result.ok) onWarning("Signed out on this device, but the server didn't confirm. The session ends on its own within 30 days.");
            });
          }}
        />
        <Button
          label={confirming ? "Sign out everywhere?" : "Sign out everywhere"}
          variant={confirming ? "destructive" : "ghost"}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            onWarning(undefined);
            // The model lands signed-out even when the request never reached the
            // server — say so, or the user believes other devices are signed out.
            void account.revokeAll().then((result) => {
              if (!result.ok) onWarning("Other devices may still be signed in. Sign in and try Sign out everywhere again.");
            });
          }}
        />
      </HStack>
      <Text type="supporting">Signing out doesn't unpair this device from its hosts. Revoke it in Devices.</Text>
    </VStack>
  );
}
