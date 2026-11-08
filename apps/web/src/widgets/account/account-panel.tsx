import { Avatar } from "@astryxdesign/core/Avatar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { type ReactNode, useEffect, useState } from "react";
import type {
  AccountDevice,
  AccountDeviceHost,
  AccountError,
  AccountHostMatch,
  AccountResult,
} from "@pinomad/client/account.ts";
import { relativeTime } from "@pinomad/client/family.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { useHosts } from "../../entities/host/host-store.ts";
import type { AccountModel, AccountState } from "../../entities/account/account-model.ts";
import { clearOAuthReturn, oauthReturn } from "../../entities/account/oauth-return.ts";
import { signInProviderName } from "../../entities/provider/sign-in-provider.tsx";
import { OFFICIAL_SERVER_ORIGIN } from "../../shared/official-server.ts";
import { ArrowLeft } from "../../shared/ui/icons.tsx";
import { GROUP_ROWS, SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { AccountEmail } from "./account-email.tsx";
import { AccountHostList, AccountPairingBanners, unpairedAccountHosts, useAccountPairing } from "./account-hosts.tsx";
import { AddHostDialog } from "./add-host.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { useConfirmIdentity } from "./confirm-identity.tsx";
import { SignInMethods } from "./sign-in-methods.tsx";
import { SignInScreen } from "./sign-in.tsx";

/** The account's pages: everything on one, and the hosts not paired here. */
export type AccountPage = "overview" | "hosts";

const PAGE_TITLE: Record<AccountPage, string> = {
  overview: "Account",
  hosts: "Hosts on this account",
};

type SignedInState = Extract<AccountState, { status: "signed-in" }>;

/**
 * Sign in to the account server, or, signed in, its pages (ADR-0022): the
 * account in groups (email, sign-in methods, devices, the sign-outs and
 * deletion), and the hosts not paired here. Settings shows the account page
 * (`page`); on its own the panel can open on the hosts and offers a way back. Renders nothing where this client
 * can't reach an account API — a host's own port, a dev server.
 */
export function AccountPanel({
  initialPage = "overview",
  page,
}: {
  initialPage?: AccountPage;
  page?: AccountPage;
}) {
  const account = useAccountModel();
  const { state } = account;
  const [ownPage, setOwnPage] = useState(initialPage);
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
    case "signed-in": {
      const current = page ?? ownPage;
      const body = (
        <AccountPageBody
          page={current}
          account={account}
          state={state}
          onNotice={setNotice}
        />
      );
      if (page !== undefined || current === "overview") return body;
      return (
        <VStack gap={4} style={{ width: "100%" }}>
          <HStack gap={2} vAlign="center">
            <IconButton
              label="Back to account"
              icon={<ArrowLeft aria-hidden="true" />}
              variant="ghost"
              size="sm"
              onClick={() => setOwnPage("overview")}
            />
            <Heading level={3}>{PAGE_TITLE[current]}</Heading>
          </HStack>
          {body}
        </VStack>
      );
    }
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

function AccountPageBody({
  page,
  account,
  state,
  onNotice,
}: {
  page: AccountPage;
  account: AccountModel;
  state: SignedInState;
  onNotice: (notice: Notice | undefined) => void;
}) {
  switch (page) {
    case "overview":
      return <Overview account={account} state={state} onNotice={onNotice} />;
    case "hosts":
      return <AccountHosts state={state} />;
  }
}

/** How a provider link from this page came back (ADR-0044 §5), said once. */
function ProviderLinkReturn() {
  const [returned] = useState(() => {
    const { linked, error } = oauthReturn();
    return linked !== undefined || error !== undefined ? { linked, error } : undefined;
  });
  useEffect(() => {
    if (returned === undefined) return;
    clearOAuthReturn("linked");
    clearOAuthReturn("error");
  }, [returned]);
  if (returned?.linked !== undefined) {
    return (
      <Banner
        status="success"
        title={`${signInProviderName(returned.linked)} linked`}
        description={`You can sign in with ${signInProviderName(returned.linked)} now.`}
      />
    );
  }
  if (returned?.error !== undefined) {
    return <Banner status="error" title="Couldn't link the account" description={accountErrorMessage({ code: returned.error })} />;
  }
  return null;
}

/**
 * Who is signed in where, then the account in groups — email, sign-in
 * methods, devices — and the two account-wide actions set apart at the bottom. Every action asks first,
 * in a dialog.
 */
function Overview({
  account,
  state,
  onNotice,
}: {
  account: AccountModel;
  state: SignedInState;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const server = new URL(state.serverOrigin).host;
  const [open, setOpen] = useState<"sign-out" | "everywhere" | "delete">();
  return (
    <VStack gap={6} style={{ width: "100%" }}>
      <ProviderLinkReturn />
      <HStack gap={3} vAlign="center">
        <Avatar name={state.user} size="lg" tooltip={false} />
        <VStack gap={0} className="min-w-0 flex-1">
          {/* An email has no spaces to wrap at; break it rather than run under the button. */}
          <Heading level={3} style={{ overflowWrap: "anywhere" }}>
            {state.user}
          </Heading>
          <Text type="supporting">{server}</Text>
        </VStack>
        <Button label="Sign out…" variant="secondary" size="sm" onClick={() => setOpen("sign-out")} />
      </HStack>
      <AccountEmail account={account} email={state.email} />
      <SignInMethods account={account} />
      <Devices account={account} hosts={state.hosts} />
      <SettingsGroup title="Danger zone" tone="danger">
        <ul aria-label="Danger zone" className={GROUP_ROWS}>
          <DangerAction
            title="Sign out everywhere"
            description="Ends every session on every device, including this one."
            action={<Button label="Sign out everywhere…" variant="secondary" size="sm" onClick={() => setOpen("everywhere")} />}
          />
          <DangerAction
            title="Delete account"
            description={`Removes your account from ${server}. Devices stay registered on your hosts.`}
            action={<Button label="Delete account…" variant="secondary" size="sm" onClick={() => setOpen("delete")} />}
          />
        </ul>
      </SettingsGroup>
      {open === "sign-out" ? (
        <SignOutDialog account={account} server={server} onNotice={onNotice} onClose={() => setOpen(undefined)} />
      ) : open === "everywhere" ? (
        <SignOutEverywhereDialog account={account} onNotice={onNotice} onClose={() => setOpen(undefined)} />
      ) : open === "delete" ? (
        <DeleteAccountDialog account={account} server={server} onNotice={onNotice} onClose={() => setOpen(undefined)} />
      ) : null}
    </VStack>
  );
}

/**
 * One irreversible action: what it does, and its button. The row wraps, so on
 * a narrow screen the button drops under the text instead of squeezing it.
 */
function DangerAction({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 py-2">
      <VStack gap={0} className="min-w-[14rem] flex-1">
        <Text>{title}</Text>
        <Text type="supporting">{description}</Text>
      </VStack>
      {action}
    </li>
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

const signOutNotice = (description: string | undefined): Notice | undefined =>
  description === undefined ? undefined : { status: "warning", title: "Sign-out not confirmed", description };

/**
 * Sign out, with the shared-computer choice off by default: a host's
 * revocation is permanent, so every sign-out of your own browser would leave
 * a dead key in each host's device list (#494).
 */
function SignOutDialog({
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
  const [revoke, setRevoke] = useState(false);
  return (
    <ConfirmDialog
      title={`Sign out of ${server}?`}
      description="This device stays paired with its hosts, unless it's a shared computer."
      onClose={onClose}
      action={
        <Button
          label="Sign out"
          variant="destructive"
          onClick={() => {
            onClose();
            onNotice(undefined);
            // The model lands signed-out at once; the answer only decides the warning.
            void account.logout({ revoke }).then((result) => onNotice(signOutNotice(signOutWarning(result, revoke))));
          }}
        />
      }
    >
      <CheckboxInput
        label="This is a shared computer"
        description="Also remove this device from the hosts it joined through your account, and forget them here. Hosts paired with a QR code stay."
        value={revoke}
        onChange={setRevoke}
      />
    </ConfirmDialog>
  );
}

function SignOutEverywhereDialog({
  account,
  onNotice,
  onClose,
}: {
  account: AccountModel;
  onNotice: (notice: Notice | undefined) => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title="Sign out everywhere?"
      description="Every session on every device ends, including this one. Devices stay paired with their hosts."
      onClose={onClose}
      action={
        <Button
          label="Sign out everywhere"
          variant="destructive"
          onClick={() => {
            onClose();
            onNotice(undefined);
            // The model lands signed-out even when the request never reached the
            // server — say so, or the user believes other devices are signed out.
            void account.revokeAll().then((result) => {
              if (!result.ok) onNotice(signOutNotice("Other devices may still be signed in. Sign in and try Sign out everywhere again."));
            });
          }}
        />
      }
    />
  );
}

/**
 * "Delete account" (#451): confirmed again, then the server deletes the
 * account and every session. Devices stay registered on the hosts (ADR-0022
 * §6: revocation lives on the host), so this device keeps its pairings.
 */
function DeleteAccountDialog({
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
      // On success the model is already signed-out and this dialog unmounted. If
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
    <ConfirmDialog
      title="Delete your account?"
      description={`This deletes your account on ${server} and signs you out everywhere. Hosts joined to it are disconnected from the server; run pinomad join on each to connect it again. This device and your others stay registered on their hosts. To remove them, revoke them in each host's Devices.`}
      onClose={onClose}
      action={<Button label="Delete account" variant="destructive" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />}
    >
      {identity.field}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't delete the account" description={accountErrorMessage(error)} />
      )}
    </ConfirmDialog>
  );
}

/** The account's hosts this device hasn't paired, and Add a host; the paired ones live in Settings → Hosts. */
function AccountHosts({ state }: { state: SignedInState }) {
  const pairing = useAccountPairing();
  const [adding, setAdding] = useState(false);
  const { hosts } = useHosts();
  const others = unpairedAccountHosts(state, hosts);
  return (
    <VStack gap={3} style={{ width: "100%" }}>
      <AccountPairingBanners state={state} pairing={pairing} />
      {state.hosts.length === 0 ? (
        <Text type="supporting">No hosts yet.</Text>
      ) : others.length === 0 ? (
        <Text type="supporting">Every host on your account is paired with this device.</Text>
      ) : (
        <SettingsGroup>
          <AccountHostList state={state} hosts={others} pairing={pairing} label="Hosts on your account" />
        </SettingsGroup>
      )}
      <HStack>
        <Button label="Add a host…" variant="secondary" size="sm" onClick={() => setAdding(true)} />
      </HStack>
      {adding ? <AddHostDialog onClose={() => setAdding(false)} /> : null}
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
 * account and asks those hosts to revoke it.
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
  // One load per mount; a removal and Retry reload explicitly.
  useEffect(() => {
    void load();
  }, [account]);
  // A server from before the list: the group isn't there at all.
  if (unsupported) return null;
  return (
    <VStack gap={2} style={{ width: "100%" }}>
      {error === undefined ? null : (
        <Banner
          status="warning"
          title="Couldn't load devices"
          description={accountErrorMessage(error)}
          endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => void load()} />}
        />
      )}
      {devices === undefined ? (
        error === undefined ? (
          <SettingsGroup title="Signed-in devices">
            <HStack style={{ padding: "var(--spacing-3)" }}>
              <Spinner size="sm" />
            </HStack>
          </SettingsGroup>
        ) : null
      ) : (
        <SettingsGroup title="Signed-in devices">
          <List hasDividers aria-label="Signed-in devices">
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
        </SettingsGroup>
      )}
      {removing === undefined ? null : (
        <RemoveDeviceDialog
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
  const name = device.name ?? "Unknown device";
  const signIn = `Last sign-in ${ago(device.lastSeenAt, now)}`;
  const end = device.current ? (
    <Token label="This device" size="sm" />
  ) : device.kickedAt !== undefined ? (
    <Token label="Removed" color="gray" size="sm" />
  ) : (
    <MoreMenu label={`More for ${name}`} size="sm" isDisabled={isBusy} items={[{ label: "Remove…", onClick: onRemove }]} />
  );
  return (
    <ListItem
      label={name}
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
function RemoveDeviceDialog({
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
  const description =
    `This signs ${name} out of your account and asks each host it joined through your account to revoke it. Hosts that are offline revoke it when they reconnect.` +
    (unreachable.length === 0
      ? ""
      : unreachable.length === 1
        ? ` The host ${unreachable[0]} can't be asked. If ${name} joined it, revoke it in that host's Devices.`
        : ` The hosts ${listNames(unreachable)} can't be asked. If ${name} joined them, revoke it in each one's Devices.`);
  return (
    <ConfirmDialog
      title={`Remove ${name}?`}
      description={description}
      onClose={() => onClose(false)}
      action={<Button label="Remove device" variant="destructive" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />}
    >
      {identity.field}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't remove the device" description={accountErrorMessage(error)} />
      )}
    </ConfirmDialog>
  );
}
