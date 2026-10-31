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
import type { AccountError, AccountHostMatch, AccountInvite, CreatedInvite, JoinToken } from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { OFFICIAL_SERVER_ORIGIN } from "../../shared/official-server.ts";
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
    case "pair_unreachable":
      return "Couldn't reach the host on any offered path. Check your network connection or Tailscale and try again.";
    case "pair_timeout":
      return "The host didn't answer on any offered path in time. Try again.";
    case "pair_unsupported":
      return "This app can't connect to any address the host offered. The page may block an insecure ws:// path; try the desktop app or a secure address.";
    case "pairing_not_saved":
      return "Paired, but this device couldn't save the pairing.";
    case "invalid_invite":
      return "This invite code isn't valid. It may have been used or revoked.";
    case "invite_expired":
      return "This invite code has expired. Ask for a new one.";
    case "invalid_username":
      return "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.";
    case "weak_password":
      return "Use a password of at least 12 characters.";
    case "username_taken":
      return "That username is taken.";
    case "forbidden":
      return "Only the server's admin can do this.";
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
  const [signingUp, setSigningUp] = useState(false);
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
          {signingUp ? (
            <SignUpForm account={account} state={state} onSignIn={() => setSigningUp(false)} />
          ) : (
            <SignInForm account={account} state={state} onSignUp={() => setSigningUp(true)} />
          )}
        </VStack>
      );
    case "signed-in":
      return <SignedIn account={account} state={state} onSignOutWarning={setSignOutWarning} />;
  }
}

function SignInForm({
  account,
  state,
  onSignUp,
}: {
  account: AccountModel;
  state: Extract<AccountState, { status: "signed-out" }>;
  onSignUp: () => void;
}) {
  // Bearer clients (desktop) pick their server, starting from the last one or
  // the official one; a cookie page is the server.
  const asksOrigin = state.mode === "bearer";
  const [origin, setOrigin] = useState(state.serverOrigin ?? OFFICIAL_SERVER_ORIGIN);
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
      <HStack gap={2} vAlign="center" hAlign="between">
        <Button label="Sign in" variant="primary" isLoading={busy} isDisabled={!ready} onClick={submit} />
        <Button label="Create an account" variant="ghost" onClick={onSignUp} />
      </HStack>
    </VStack>
  );
}

/** Sign-up with an invite from the server's admin (#449); lands signed in. */
function SignUpForm({
  account,
  state,
  onSignIn,
}: {
  account: AccountModel;
  state: Extract<AccountState, { status: "signed-out" }>;
  onSignIn: () => void;
}) {
  const asksOrigin = state.mode === "bearer";
  const [origin, setOrigin] = useState(state.serverOrigin ?? OFFICIAL_SERVER_ORIGIN);
  const [invite, setInvite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const ready =
    invite.trim() !== "" && username.trim() !== "" && password !== "" && (!asksOrigin || origin.trim() !== "");
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    void account
      .register({
        invite: invite.trim(),
        username: username.trim(),
        password,
        ...(asksOrigin ? { serverOrigin: origin.trim() } : {}),
      })
      .then((result) => {
        setBusy(false);
        if (!result.ok) setError(result.error);
      });
  };
  return (
    <VStack gap={3} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>Create an account</Heading>
        <Text type="supporting">You need an invite code from the server's admin.</Text>
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
      <TextInput label="Invite code" value={invite} onChange={setInvite} onEnter={submit} width="100%" />
      <TextInput
        label="Username"
        description="Lowercase letters, digits, dots, dashes or underscores"
        value={username}
        onChange={setUsername}
        onEnter={submit}
        width="100%"
      />
      <TextInput
        label="Password"
        description="At least 12 characters"
        type="password"
        value={password}
        onChange={setPassword}
        onEnter={submit}
        width="100%"
      />
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't create the account" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2} vAlign="center" hAlign="between">
        <Button label="Create account" variant="primary" isLoading={busy} isDisabled={!ready} onClick={submit} />
        <Button label="Sign in instead" variant="ghost" onClick={onSignIn} />
      </HStack>
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
  const { focusHost } = useHosts();
  const server = new URL(state.serverOrigin).host;
  // A saved retry finishes what Pair started: focus the host, no reload.
  const retrySave = (host: StoredHost): void => {
    setActionError(undefined);
    void account.retryUnsavedHost(host.account?.hostId).then((result) => {
      if (result.ok) focusHost(host.hostKey);
      else setActionError(result.error);
    });
  };
  return (
    <VStack gap={4} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>{state.user}</Heading>
        <Text type="supporting">Signed in to {server}</Text>
      </VStack>
      {state.unsavedHosts.map((host) => (
        <Banner
          key={host.hostKey}
          status="warning"
          title="This pairing wasn't saved"
          description={`${host.name ?? host.url} will be lost when the app restarts.`}
          endContent={<Button label="Retry" variant="ghost" onClick={() => retrySave(host)} />}
        />
      ))}
      <HostList account={account} state={state} onError={setActionError} />
      {actionError === undefined ? null : (
        <Banner status="error" title="Couldn't pair" description={accountErrorMessage(actionError)} />
      )}
      <AddHost account={account} />
      {state.admin ? <Invites account={account} /> : null}
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
  const { focus, focusHost } = useHosts();
  const [pairing, setPairing] = useState<string>();
  const pair = (hostId: string): void => {
    setPairing(hostId);
    onError(undefined);
    void account.pairHost(hostId).then((result) => {
      setPairing(undefined);
      if (result.ok) focusHost(result.value.hostKey);
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
              isCurrent={match.status === "paired" && match.stored?.hostKey === focus?.hostKey}
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
  const { focusHost } = useHosts();
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
      <Button label="Connect" variant="secondary" size="sm" onClick={() => focusHost(stored!.hostKey)} />
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

/** "Just now" or "3d ago" — relativeTime's past form for sentences. */
const ago = (at: number, now: number): string => {
  const span = relativeTime(at, now);
  return span === "now" ? "just now" : `${span} ago`;
};

/** The admin's sign-up invites (#449): mint one, see who used which, revoke unused ones. */
function Invites({ account }: { account: AccountModel }) {
  const now = useNow(60_000);
  const [invites, setInvites] = useState<readonly AccountInvite[]>();
  const [created, setCreated] = useState<CreatedInvite>();
  const [error, setError] = useState<AccountError>();
  const [busy, setBusy] = useState(false);
  const load = (): Promise<void> =>
    account.listInvites().then((result) => {
      if (result.ok) setInvites(result.value);
      else setError(result.error);
    });
  // One load per mount; create and revoke reload explicitly.
  useEffect(() => {
    void load();
  }, [account]);
  const create = (): void => {
    setBusy(true);
    setError(undefined);
    void account.createInvite().then(async (result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreated(result.value);
      await load();
    });
  };
  const revoke = (id: number): void => {
    setError(undefined);
    void account.revokeInvite(id).then(async (result) => {
      if (!result.ok) setError(result.error);
      await load();
    });
  };
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text weight="semibold">Invites</Text>
        <Button label="Create invite" variant="secondary" size="sm" isLoading={busy} onClick={create} />
      </HStack>
      {created === undefined ? null : (
        <VStack gap={2}>
          <Text type="supporting">Send this code to the person you're inviting. It won't be shown again.</Text>
          <CodeBlock code={created.code} hasCopyButton isWrapped />
          <HStack gap={2} vAlign="center" hAlign="between">
            <Text type="supporting">Works once · expires in {relativeTime(now, created.expiresAt)}</Text>
            <Button label="Done" variant="ghost" size="sm" onClick={() => setCreated(undefined)} />
          </HStack>
        </VStack>
      )}
      {invites === undefined || invites.length === 0 ? (
        invites === undefined ? null : <Text type="supporting">No invites yet. Each one lets one person create an account.</Text>
      ) : (
        <List density="compact">
          {invites.map((invite) => (
            <InviteRow key={invite.id} invite={invite} now={now} onRevoke={() => revoke(invite.id)} />
          ))}
        </List>
      )}
      {error === undefined ? null : <Banner status="error" title="Couldn't update invites" description={accountErrorMessage(error)} />}
    </VStack>
  );
}

function InviteRow({ invite, now, onRevoke }: { invite: AccountInvite; now: number; onRevoke: () => void }) {
  if (invite.usedAt !== undefined) {
    return (
      <ListItem
        label={invite.usedBy === undefined ? "Used" : `Used by ${invite.usedBy}`}
        description={`Signed up ${ago(invite.usedAt, now)}`}
      />
    );
  }
  if (invite.expiresAt <= now) {
    return <ListItem label="Expired" description={`Created ${ago(invite.createdAt, now)}`} />;
  }
  return (
    <ListItem
      label="Unused"
      description={`Created ${ago(invite.createdAt, now)} · expires in ${relativeTime(now, invite.expiresAt)}`}
      endContent={<Button label="Revoke" variant="ghost" size="sm" onClick={onRevoke} />}
    />
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
