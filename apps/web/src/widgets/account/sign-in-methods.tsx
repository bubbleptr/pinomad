import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AccountConfirmation, AccountError, AccountIdentities, AccountResult } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { knownSignInProviders, signInProviderName, SignInProviderMark } from "../../entities/provider/sign-in-provider.tsx";
import { SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { MIN_PASSWORD_LENGTH, NEW_PASSWORD_INPUT, passwordLength } from "./code-input.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";

/** What the section has open: one form at a time. */
type Open =
  | { readonly kind: "password" }
  | { readonly kind: "remove"; readonly provider: string }
  | { readonly kind: "link"; readonly provider: string };

/**
 * "Sign-in methods" (ADR-0044 §4): the password and each linked provider,
 * removable unless it's the last way in; linking another one where a browser
 * can go to the provider and back: this page itself on the server's own
 * origin, the system browser in the desktop app (#631).
 */
export function SignInMethods({
  account,
  navigate = (url) => window.location.assign(url),
}: {
  account: AccountModel;
  navigate?: (url: string) => void;
}) {
  const [identities, setIdentities] = useState<AccountIdentities>();
  const [offered, setOffered] = useState<readonly string[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [open, setOpen] = useState<Open>();
  const [done, setDone] = useState<string>();
  const load = (): void => {
    void account.identities().then((result) => {
      if (result.ok) setIdentities(result.value);
      else if (result.error.status === 404) setUnsupported(true);
    });
  };
  useEffect(() => {
    load();
    if (account.providerFlow === undefined) return;
    let live = true;
    void account.authMethods().then((result) => {
      if (live && result.ok) setOffered(result.value.providers);
    });
    return () => {
      live = false;
    };
  }, [account]);
  // A server from before sign-in methods: only the password, as it always was.
  if (unsupported) return <ChangePasswordOnly account={account} />;
  if (identities === undefined) {
    return (
      <VStack gap={2}>
        <Text weight="semibold">Sign-in methods</Text>
        <Spinner size="sm" />
      </VStack>
    );
  }
  const linked = new Set(identities.identities.map((identity) => identity.provider));
  const linkable = account.providerFlow === undefined ? [] : knownSignInProviders(offered).filter((provider) => !linked.has(provider.id));
  const close = (message?: string): void => {
    setOpen(undefined);
    setDone(message);
    if (message !== undefined) load();
  };
  const busy = open !== undefined;
  const start = (next: Open): void => {
    setDone(undefined);
    setOpen(next);
  };
  return (
    <VStack gap={2}>
      <SettingsGroup title="Sign-in methods">
      <List hasDividers aria-label="Sign-in methods">
        <ListItem
          label="Password"
          description={identities.hasPassword ? "Set" : "Not set"}
          endContent={
            <Button
              label={identities.hasPassword ? "Change password…" : "Set password…"}
              variant="secondary"
              size="sm"
              isDisabled={busy}
              onClick={() => start({ kind: "password" })}
            />
          }
        />
        {identities.identities.map((identity) => (
          <ListItem
            key={identity.provider}
            label={signInProviderName(identity.provider)}
            description={identity.email}
            startContent={<SignInProviderMark provider={identity.provider} />}
            endContent={
              <MoreMenu
                label={`More for ${signInProviderName(identity.provider)}`}
                size="sm"
                isDisabled={busy}
                items={[{ label: "Remove…", onClick: () => start({ kind: "remove", provider: identity.provider }) }]}
              />
            }
          />
        ))}
        {linkable.length === 0 ? null : (
          <ListItem
            label="Another way to sign in"
            description={orList(linkable.map((provider) => provider.name))}
            endContent={
              <DropdownMenu
                button={{ label: "Link another…", variant: "secondary", size: "sm", isDisabled: busy }}
                hasChevron={false}
                items={linkable.map((provider) => ({
                  label: provider.name,
                  icon: <SignInProviderMark provider={provider.id} />,
                  onClick: () => start({ kind: "link", provider: provider.id }),
                }))}
              />
            }
          />
        )}
      </List>
      </SettingsGroup>
      {done === undefined ? null : <Text type="supporting">{done}</Text>}
      {open?.kind === "password" ? (
        <PasswordForm account={account} hasPassword={identities.hasPassword} onClose={close} />
      ) : open?.kind === "remove" ? (
        <ConfirmedAction
          account={account}
          title={`Remove ${signInProviderName(open.provider)}?`}
          description={`You won't be able to sign in with ${signInProviderName(open.provider)} until you link it again.`}
          label={`Remove ${signInProviderName(open.provider)}`}
          variant="destructive"
          errorTitle="Couldn't remove it"
          action={(confirmation) => account.unlinkProvider(open.provider, confirmation)}
          onDone={() => close(`${signInProviderName(open.provider)} removed.`)}
          onCancel={() => close()}
        />
      ) : open?.kind === "link" ? (
        <ConfirmedAction
          account={account}
          title={`Link ${signInProviderName(open.provider)}`}
          description={
            account.providerFlow === "loopback"
              ? `Your browser opens ${signInProviderName(open.provider)} to choose the account. Come back here when it's done.`
              : `You'll go to ${signInProviderName(open.provider)} to choose the account, then come back here.`
          }
          label={`Continue to ${signInProviderName(open.provider)}`}
          variant="primary"
          errorTitle="Couldn't start linking"
          action={async (confirmation) => {
            const result = await account.linkProvider(open.provider, confirmation);
            if (!result.ok || result.value.redirect === undefined) return result;
            navigate(result.value.redirect);
            // The page is leaving for the provider.
            return new Promise<never>(() => {});
          }}
          onDone={() => close(`${signInProviderName(open.provider)} linked.`)}
          onCancel={() => close()}
        />
      ) : null}
    </VStack>
  );
}

/**
 * One confirmed account change: the confirmation field, the action's own
 * button and a Cancel. A refused grant is dropped so the next try asks again.
 * An answer that arrives after Cancel (a desktop link finishing in the
 * browser) is dropped: by then another form may be open.
 */
function ConfirmedAction({
  account,
  title,
  description,
  label,
  variant,
  errorTitle,
  action,
  onDone,
  onCancel,
  extra,
  isReady = true,
}: {
  account: AccountModel;
  title: string;
  description?: string;
  label: string;
  variant: "primary" | "destructive";
  errorTitle: string;
  action: (confirmation: AccountConfirmation) => Promise<AccountResult<unknown>>;
  onDone: () => void;
  onCancel: () => void;
  /** More fields under the confirmation, given the submit for their Enter. */
  extra?: (submit: () => void) => ReactNode;
  isReady?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = (): void => {
    if (!identity.ready || !isReady || busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await action(confirmation.value) : confirmation;
      if (!mounted.current) return;
      setBusy(false);
      if (result.ok) onDone();
      else {
        if (result.error.code === "invalid_reauth") identity.reset();
        setError(result.error);
      }
    })();
  };
  const identity = useConfirmIdentity(account, submit);
  return (
    <ConfirmDialog
      title={title}
      {...(description === undefined ? {} : { description })}
      onClose={onCancel}
      action={<Button label={label} variant={variant} isLoading={busy} isDisabled={!identity.ready || !isReady} onClick={submit} />}
    >
      {identity.field}
      {extra?.(submit)}
      {error === undefined ? null : <Banner status="error" title={errorTitle} description={accountErrorMessage(error)} />}
    </ConfirmDialog>
  );
}

/** Set a first password, or change the one there is; the account's other sessions end (#450). */
function PasswordForm({
  account,
  hasPassword,
  onClose,
}: {
  account: AccountModel;
  hasPassword: boolean;
  onClose: (message?: string) => void;
}) {
  const [next, setNext] = useState("");
  const verb = hasPassword ? "Change password" : "Set password";
  return (
    <ConfirmedAction
      account={account}
      title={verb}
      label={verb}
      variant="primary"
      errorTitle={hasPassword ? "Couldn't change the password" : "Couldn't set the password"}
      isReady={next !== ""}
      action={async (confirmation) =>
        passwordLength(next) < MIN_PASSWORD_LENGTH
          ? { ok: false, error: { code: "weak_password" } }
          : account.changePassword({ confirmation, newPassword: next })
      }
      onDone={() => onClose(hasPassword ? "Password changed. Your other devices were signed out." : "Password set.")}
      onCancel={() => onClose()}
      extra={(submit) => (
        <TextInput
          label="New password"
          description="Your other devices will be signed out."
          type="password"
          value={next}
          onChange={setNext}
          onEnter={submit}
          width="100%"
          {...NEW_PASSWORD_INPUT}
        />
      )}
    />
  );
}

/** A server that can't list sign-in methods: only the password to change. */
function ChangePasswordOnly({ account }: { account: AccountModel }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string>();
  if (open) {
    return (
      <PasswordForm
        account={account}
        hasPassword
        onClose={(message) => {
          setOpen(false);
          setDone(message);
        }}
      />
    );
  }
  return (
    <VStack gap={1}>
      <HStack gap={2}>
        <Button
          label="Change password…"
          variant="secondary"
          size="sm"
          onClick={() => {
            setDone(undefined);
            setOpen(true);
          }}
        />
      </HStack>
      {done === undefined ? null : <Text type="supporting">{done}</Text>}
    </VStack>
  );
}

/** "Google", "Google or Apple", "Google, Apple or Microsoft". */
const orList = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
