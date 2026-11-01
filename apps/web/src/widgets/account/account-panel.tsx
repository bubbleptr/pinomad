import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
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
import type {
  AccountDevice,
  AccountDeviceHost,
  AccountError,
  AccountHostMatch,
  AccountInvite,
  AccountResult,
  CreatedInvite,
} from "@pinomad/client/account.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { OFFICIAL_SERVER_ORIGIN } from "../../shared/official-server.ts";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { AddHostSteps } from "./add-host.tsx";

/**
 * Sign in to the account server, see its hosts, pair or connect to them, and
 * add new ones (ADR-0022). Renders nothing where this client can't reach an
 * account API — a host's own port, a dev server.
 */
export function AccountPanel() {
  const account = useAccountModel();
  const { state } = account;
  // Lives here, not in SignedIn: a failed sign-out and a deleted account both
  // land signed-out, and what they say has to survive that unmount.
  const [notice, setNotice] = useState<Notice>();
  // A sign-in ends the story the notice told; a later expiry mustn't repeat it.
  useEffect(() => {
    if (state.status === "signed-in") setNotice(undefined);
  }, [state.status]);
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
          {notice === undefined ? null : <Banner {...notice} />}
          <SignedOut account={account} state={state} />
        </VStack>
      );
    case "signed-in":
      return <SignedIn account={account} state={state} onNotice={setNotice} />;
  }
}

/** What the signed-out panel says about how it got there. */
interface Notice {
  readonly status: "warning" | "success";
  readonly title: string;
  readonly description: string;
}

/** Sign-in or sign-up; both forms share the server address the user typed. */
function SignedOut({ account, state }: { account: AccountModel; state: Extract<AccountState, { status: "signed-out" }> }) {
  // Bearer clients (desktop) pick their server, starting from the last one or
  // the official one; a cookie page is the server.
  const [origin, setOrigin] = useState(state.serverOrigin ?? OFFICIAL_SERVER_ORIGIN);
  const [signingUp, setSigningUp] = useState(false);
  const server = state.mode === "bearer" ? { origin, setOrigin } : undefined;
  return signingUp ? (
    <SignUpForm account={account} server={server} onSignIn={() => setSigningUp(false)} />
  ) : (
    <SignInForm account={account} server={server} onSignUp={() => setSigningUp(true)} />
  );
}

/** The Server field's value and setter; absent on a cookie page, which is the server. */
interface ServerField {
  readonly origin: string;
  readonly setOrigin: (origin: string) => void;
}

function SignInForm({
  account,
  server,
  onSignUp,
}: {
  account: AccountModel;
  server: ServerField | undefined;
  onSignUp: () => void;
}) {
  const asksOrigin = server !== undefined;
  const origin = server?.origin ?? "";
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
      {server === undefined ? null : (
        <TextInput
          label="Server"
          placeholder="https://nomad.example.com"
          value={server.origin}
          onChange={server.setOrigin}
          onEnter={submit}
          width="100%"
        />
      )}
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
  server,
  onSignIn,
}: {
  account: AccountModel;
  server: ServerField | undefined;
  onSignIn: () => void;
}) {
  const asksOrigin = server !== undefined;
  const origin = server?.origin ?? "";
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
      {server === undefined ? null : (
        <TextInput
          label="Server"
          placeholder="https://nomad.example.com"
          value={server.origin}
          onChange={server.setOrigin}
          onEnter={submit}
          width="100%"
        />
      )}
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
  onNotice,
}: {
  account: AccountModel;
  state: Extract<AccountState, { status: "signed-in" }>;
  onNotice: (notice: Notice | undefined) => void;
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
      <AddHost account={account} serverOrigin={state.serverOrigin} />
      <Devices account={account} hosts={state.hosts} />
      {state.admin ? <Invites account={account} /> : null}
      <ChangePassword account={account} />
      <SignOut account={account} onNotice={onNotice} />
      {state.admin ? null : <DeleteAccount account={account} server={server} onNotice={onNotice} />}
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

/** "Add a host": the command to run on the new machine and the field for the code it prints (#496). */
function AddHost({ account, serverOrigin }: { account: AccountModel; serverOrigin: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button label="Add a host" variant="secondary" onClick={() => setOpen(true)} />;
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text weight="semibold">Add a host</Text>
        <Button
          label="Done"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            void account.refreshHosts();
          }}
        />
      </HStack>
      <AddHostSteps serverOrigin={serverOrigin} />
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

/** A device's standing on one host, as the row says it (ADR-0037 §6). */
const DEVICE_HOST_STATE: Record<AccountDeviceHost["state"], string> = {
  registered: "registered",
  revoking: "waiting for the host to revoke",
  revoked: "revoked",
};

/**
 * The account's devices (#452, ADR-0037): every install that signed in, where
 * it joined through the account, and Remove — which signs it out of the
 * account and asks those hosts to revoke it. Hidden on servers that predate
 * the list.
 */
function Devices({ account, hosts }: { account: AccountModel; hosts: readonly AccountHostMatch[] }) {
  const now = useNow(60_000);
  const [devices, setDevices] = useState<readonly AccountDevice[]>();
  const [error, setError] = useState<AccountError>();
  const [unsupported, setUnsupported] = useState(false);
  const [removing, setRemoving] = useState<AccountDevice>();
  const load = (): Promise<void> =>
    account.listDevices().then((result) => {
      if (result.ok) {
        setDevices(result.value);
        setError(undefined);
      } else if (result.error.status === 404) setUnsupported(true);
      else setError(result.error);
    });
  // One load per mount; Refresh and a removal reload explicitly.
  useEffect(() => {
    void load();
  }, [account]);
  if (unsupported) return null;
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <Text weight="semibold">Devices</Text>
        <Button label="Refresh" variant="ghost" size="sm" onClick={() => void load()} />
      </HStack>
      {error === undefined ? null : (
        <Banner status="warning" title="Couldn't load devices" description={accountErrorMessage(error)} />
      )}
      {devices === undefined || devices.length === 0 ? null : (
        <List density="compact">
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              now={now}
              isBusy={removing !== undefined}
              onRemove={() => setRemoving(device)}
            />
          ))}
        </List>
      )}
      {removing === undefined ? null : (
        <RemoveDevice
          account={account}
          device={removing}
          hosts={hosts}
          onClose={(removed) => {
            setRemoving(undefined);
            if (removed) void load();
          }}
        />
      )}
    </VStack>
  );
}

function DeviceRow({
  device,
  now,
  isBusy,
  onRemove,
}: {
  device: AccountDevice;
  now: number;
  isBusy: boolean;
  onRemove: () => void;
}) {
  const signIn = `Last sign-in ${ago(device.lastSeenAt, now)}`;
  const end = device.current ? (
    <Token label="This device" size="sm" />
  ) : device.kickedAt !== undefined ? (
    <Token label="Removed" color="gray" size="sm" />
  ) : (
    <Button label="Remove" variant="ghost" size="sm" isDisabled={isBusy} onClick={onRemove} />
  );
  return (
    <ListItem
      label={device.name ?? "Unknown device"}
      description={
        <VStack gap={0}>
          <Text type="inherit">
            {device.kickedAt === undefined ? signIn : `${signIn} · removed ${ago(device.kickedAt, now)}`}
          </Text>
          {device.hosts.length === 0 ? null : (
            <Text type="inherit">
              {device.hosts.map((host) => `${host.name}: ${DEVICE_HOST_STATE[host.state]}`).join(" · ")}
            </Text>
          )}
        </VStack>
      }
      endContent={end}
    />
  );
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The password again, as for deleting the account (ADR-0037 §3): a session
 * left on a lost phone mustn't be able to remove the owner's other devices.
 */
function RemoveDevice({
  account,
  device,
  hosts,
  onClose,
}: {
  account: AccountModel;
  device: AccountDevice;
  hosts: readonly AccountHostMatch[];
  onClose: (removed: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const name = device.name ?? "this device";
  // A host that doesn't report devices never shows up in device.hosts, so
  // there's no telling whether this device joined it: name them all.
  const unreachable = hosts.filter((match) => match.host.deviceReports === false).map((match) => match.host.name);
  const submit = (): void => {
    if (password === "" || busy) return;
    setBusy(true);
    setError(undefined);
    void account.kickDevice({ id: device.id, password }).then((result) => {
      setBusy(false);
      // Already gone (removed from another device): the reload shows it.
      if (result.ok || result.error.code === "not_found") onClose(true);
      else setError(result.error);
    });
  };
  return (
    <VStack gap={2}>
      <Text weight="semibold">Remove {name}</Text>
      <Text type="supporting">
        This signs {name} out of your account and asks each host it joined through your account to revoke it. Hosts that
        are offline revoke it when they reconnect.
        {unreachable.length === 0
          ? null
          : unreachable.length === 1
            ? ` The host ${unreachable[0]} can't be asked. If ${name} joined it, revoke it in that host's Devices.`
            : ` The hosts ${listNames(unreachable)} can't be asked. If ${name} joined them, revoke it in each one's Devices.`}
      </Text>
      <TextInput label="Password" type="password" value={password} onChange={setPassword} onEnter={submit} width="100%" />
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't remove the device" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Remove device" variant="destructive" isLoading={busy} isDisabled={password === ""} onClick={submit} />
        <Button label="Cancel" variant="ghost" onClick={() => onClose(false)} />
      </HStack>
    </VStack>
  );
}

/**
 * "Change password" (#450): this session stays, the account's others end. A
 * forgotten password has no form here — the server's admin resets it.
 */
function ChangePassword({ account }: { account: AccountModel }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const [changed, setChanged] = useState(false);
  const ready = current !== "" && next !== "";
  const close = (): void => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setError(undefined);
  };
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    void account.changePassword({ currentPassword: current, newPassword: next }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      setChanged(true);
    });
  };
  if (!open) {
    return (
      <VStack gap={1}>
        <HStack gap={2}>
          <Button
            label="Change password"
            variant="ghost"
            onClick={() => {
              setChanged(false);
              setOpen(true);
            }}
          />
        </HStack>
        {changed ? <Text type="supporting">Password changed. Your other devices were signed out.</Text> : null}
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
      <Text weight="semibold">Change password</Text>
      <TextInput label="Current password" type="password" value={current} onChange={setCurrent} onEnter={submit} width="100%" />
      <TextInput
        label="New password"
        description="At least 12 characters. Your other devices will be signed out."
        type="password"
        value={next}
        onChange={setNext}
        onEnter={submit}
        width="100%"
      />
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't change the password" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Change password" variant="primary" isLoading={busy} isDisabled={!ready} onClick={submit} />
        <Button label="Cancel" variant="ghost" onClick={close} />
      </HStack>
    </VStack>
  );
}

/** What a sign-out that didn't fully land leaves behind, or undefined when it did. */
function signOutWarning(result: AccountResult<void>, revoke: boolean): string | undefined {
  if (result.ok) return undefined;
  if (result.error.code === "hosts_not_forgotten") {
    return "Some hosts couldn't be removed from this device, so it may still connect to them. Forget them in the host list, or revoke this device on each host.";
  }
  return revoke
    ? "This device forgot its account hosts, but the server didn't confirm asking them to revoke it. Remove it from another device, or revoke it on each host."
    : "Signed out on this device, but the server didn't confirm. The session ends on its own within 30 days.";
}

function SignOut({ account, onNotice }: { account: AccountModel; onNotice: (notice: Notice | undefined) => void }) {
  // Plain sign-out opens a confirmation holding the shared-computer choice,
  // off by default: a host's revocation is permanent, so every sign-out of
  // your own browser would leave a dead key in each host's device list (#494).
  const [open, setOpen] = useState(false);
  const [revoke, setRevoke] = useState(false);
  // Signing out everywhere ends every session at once — one extra click to confirm.
  const [confirming, setConfirming] = useState(false);
  const onWarning = (description: string | undefined): void =>
    onNotice(description === undefined ? undefined : { status: "warning", title: "Sign-out not confirmed", description });
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(timer);
  }, [confirming]);
  if (open) {
    return (
      <VStack gap={2}>
        <Text weight="semibold">Sign out</Text>
        <CheckboxInput
          label="This is a shared computer"
          description="Also remove this device from the hosts it joined through your account, and forget them here. Hosts paired with a QR code stay."
          value={revoke}
          onChange={setRevoke}
        />
        <HStack gap={2}>
          <Button
            label="Sign out"
            variant={revoke ? "destructive" : "primary"}
            onClick={() => {
              onWarning(undefined);
              // The model lands signed-out at once; the answer only decides the warning.
              void account.logout({ revoke }).then((result) => onWarning(signOutWarning(result, revoke)));
            }}
          />
          <Button
            label="Cancel"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setRevoke(false);
            }}
          />
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack gap={1}>
      <HStack gap={2}>
        <Button
          label="Sign out"
          variant="ghost"
          onClick={() => {
            setConfirming(false);
            setOpen(true);
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
      <Text type="supporting">Signing out keeps this device paired with its hosts, unless you say it's a shared computer.</Text>
    </VStack>
  );
}

/**
 * "Delete account" (#451): the password again, then the server deletes the
 * account and every session. Devices stay registered on the hosts (ADR-0022
 * §6: revocation lives on the host), so this device keeps its pairings. The
 * admin account can't be deleted; the panel hides this for it.
 */
function DeleteAccount({
  account,
  server,
  onNotice,
}: {
  account: AccountModel;
  server: string;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const close = (): void => {
    setOpen(false);
    setPassword("");
    setError(undefined);
  };
  const submit = (): void => {
    if (password === "" || busy) return;
    setBusy(true);
    setError(undefined);
    void account.deleteAccount({ password }).then((result) => {
      // On success the model is already signed-out and this form unmounted. If
      // another account signed in meanwhile, the notice would be about the wrong one.
      if (result.ok) {
        if (account.state.status !== "signed-out") return;
        onNotice({
          status: "success",
          title: "Account deleted",
          description: "This device is still registered on your hosts. To remove it, revoke it in each host's Devices.",
        });
        return;
      }
      setBusy(false);
      setError(result.error);
    });
  };
  if (!open) {
    return (
      <HStack gap={2}>
        <Button label="Delete account" variant="ghost" onClick={() => setOpen(true)} />
      </HStack>
    );
  }
  return (
    <VStack gap={2}>
      <Text weight="semibold">Delete account</Text>
      <Text type="supporting">
        This deletes your account on {server} and signs you out everywhere. Hosts joined to it are disconnected from the
        server; run pinomad join on each to connect it again. This device and your others stay registered on their hosts.
        To remove them, revoke them in each host's Devices.
      </Text>
      <TextInput label="Password" type="password" value={password} onChange={setPassword} onEnter={submit} width="100%" />
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't delete the account" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Delete account" variant="destructive" isLoading={busy} isDisabled={password === ""} onClick={submit} />
        <Button label="Cancel" variant="ghost" onClick={close} />
      </HStack>
    </VStack>
  );
}
