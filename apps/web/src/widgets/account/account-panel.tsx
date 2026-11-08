import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useState } from "react";
import type {
  AccountDevice,
  AccountDeviceHost,
  AccountError,
  AccountHostMatch,
  AccountResult,
} from "@pinomad/client/account.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { clearOAuthReturn, oauthReturn } from "../../entities/account/oauth-return.ts";
import { signInProviderName } from "../../entities/provider/sign-in-provider.tsx";
import { OFFICIAL_SERVER_ORIGIN } from "../../shared/official-server.ts";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { AccountEmail } from "./account-email.tsx";
import { AccountHostList, AccountPairingBanners, unpairedAccountHosts, useAccountPairing, type AccountPairing } from "./account-hosts.tsx";
import { AddHostSteps } from "./add-host.tsx";
import { useConfirmIdentity } from "./confirm-identity.tsx";
import { SignInMethods } from "./sign-in-methods.tsx";
import { SignInScreen } from "./sign-in.tsx";

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

function SignedOut({ account, state }: { account: AccountModel; state: Extract<AccountState, { status: "signed-out" }> }) {
  // Bearer clients (desktop) pick their server, starting from the last one or
  // the official one; a cookie page is the server.
  const [origin, setOrigin] = useState(state.serverOrigin ?? OFFICIAL_SERVER_ORIGIN);
  const server = state.mode === "bearer" ? { origin, setOrigin } : undefined;
  // A provider sign-in that came back refused says so once, here.
  const [returned] = useState(() => oauthReturn().error);
  useEffect(() => {
    if (returned !== undefined) clearOAuthReturn("error");
  }, [returned]);
  return <SignInScreen account={account} server={server} initialError={returned} />;
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
  const pairing = useAccountPairing();
  const server = new URL(state.serverOrigin).host;
  // How a provider link from this page came back (ADR-0044 §5), said once.
  const [returned] = useState(() => {
    const { linked, error } = oauthReturn();
    return linked !== undefined || error !== undefined ? { linked, error } : undefined;
  });
  useEffect(() => {
    if (returned === undefined) return;
    clearOAuthReturn("linked");
    clearOAuthReturn("error");
  }, [returned]);
  return (
    <VStack gap={4} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>{state.user}</Heading>
        <Text type="supporting">Signed in to {server}</Text>
      </VStack>
      {returned?.linked !== undefined ? (
        <Banner
          status="success"
          title={`${signInProviderName(returned.linked)} linked`}
          description={`You can sign in with ${signInProviderName(returned.linked)} now.`}
        />
      ) : returned?.error !== undefined ? (
        <Banner status="error" title="Couldn't link the account" description={accountErrorMessage({ code: returned.error })} />
      ) : null}
      <AccountPairingBanners state={state} pairing={pairing} />
      <AccountHosts state={state} pairing={pairing} />
      <AddHost account={account} serverOrigin={state.serverOrigin} />
      <Devices account={account} hosts={state.hosts} />
      <AccountEmail account={account} email={state.email} />
      <SignInMethods account={account} />
      <SignOut account={account} onNotice={onNotice} />
      <DeleteAccount account={account} server={server} onNotice={onNotice} />
    </VStack>
  );
}

/** The account's hosts this device hasn't paired; the paired ones live in Settings → Hosts. */
function AccountHosts({ state, pairing }: { state: Extract<AccountState, { status: "signed-in" }>; pairing: AccountPairing }) {
  const others = unpairedAccountHosts(state);
  return (
    <VStack gap={2}>
      <Text weight="semibold">Hosts</Text>
      {state.hosts.length === 0 ? (
        <Text type="supporting">No hosts yet. Add one below.</Text>
      ) : others.length === 0 ? (
        <Text type="supporting">Every host on your account is paired with this device.</Text>
      ) : (
        <AccountHostList state={state} hosts={others} pairing={pairing} label="Hosts on your account" />
      )}
    </VStack>
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
          variant="secondary"
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
        <Button label="Refresh" variant="secondary" size="sm" onClick={() => void load()} />
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
    <Button label="Remove" variant="secondary" size="sm" isDisabled={isBusy} onClick={onRemove} />
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
 * Confirmed again, as for deleting the account (ADR-0037 §3, ADR-0044 §6): a session
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const name = device.name ?? "this device";
  // A host that doesn't report devices never shows up in device.hosts, so
  // there's no telling whether this device joined it: name them all.
  const unreachable = hosts.filter((match) => match.host.deviceReports === false).map((match) => match.host.name);
  const submit = (): void => {
    if (!identity.ready || busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await account.kickDevice({ id: device.id, confirmation: confirmation.value }) : confirmation;
      setBusy(false);
      // Already gone (removed from another device): the reload shows it.
      if (result.ok || result.error.code === "not_found") onClose(true);
      else {
        if (result.error.code === "invalid_reauth") identity.reset();
        setError(result.error);
      }
    })();
  };
  const identity = useConfirmIdentity(account, submit);
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
      {identity.field}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't remove the device" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Remove device" variant="destructive" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />
        <Button label="Cancel" variant="secondary" onClick={() => onClose(false)} />
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
            variant="secondary"
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
          variant="secondary"
          onClick={() => {
            setConfirming(false);
            setOpen(true);
          }}
        />
        <Button
          label={confirming ? "Sign out everywhere?" : "Sign out everywhere"}
          variant={confirming ? "destructive" : "secondary"}
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
 * "Delete account" (#451): confirmed again, then the server deletes the
 * account and every session. Devices stay registered on the hosts (ADR-0022
 * §6: revocation lives on the host), so this device keeps its pairings.
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
  if (!open) {
    return (
      <HStack gap={2}>
        <Button label="Delete account" variant="secondary" onClick={() => setOpen(true)} />
      </HStack>
    );
  }
  return <DeleteAccountForm account={account} server={server} onNotice={onNotice} onClose={() => setOpen(false)} />;
}

function DeleteAccountForm({
  account,
  server,
  onNotice,
  onClose,
}: {
  account: AccountModel;
  server: string;
  onNotice: (notice: Notice | undefined) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const submit = (): void => {
    if (!identity.ready || busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      return confirmation.ok ? account.deleteAccount({ confirmation: confirmation.value }) : confirmation;
    })().then((result) => {
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
      if (result.error.code === "invalid_reauth") identity.reset();
      setError(result.error);
    });
  };
  const identity = useConfirmIdentity(account, submit);
  return (
    <VStack gap={2}>
      <Text weight="semibold">Delete account</Text>
      <Text type="supporting">
        This deletes your account on {server} and signs you out everywhere. Hosts joined to it are disconnected from the
        server; run pinomad join on each to connect it again. This device and your others stay registered on their hosts.
        To remove them, revoke them in each host's Devices.
      </Text>
      {identity.field}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't delete the account" description={accountErrorMessage(error)} />
      )}
      <HStack gap={2}>
        <Button label="Delete account" variant="destructive" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />
        <Button label="Cancel" variant="secondary" onClick={onClose} />
      </HStack>
    </VStack>
  );
}
