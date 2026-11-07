import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useState } from "react";
import type { AccountError, AccountResult, PendingSignIn } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { clearOAuthReturn, oauthReturn } from "../../entities/account/oauth-return.ts";
import { signInProviderName, SignInProviderMark } from "../../entities/provider/sign-in-provider.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { MIN_PASSWORD_LENGTH, NEW_PASSWORD_INPUT, passwordLength } from "./code-input.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";

/**
 * A provider sign-in that found no account (ADR-0044 §4), over whatever
 * screen App shows: the server sent the browser to `/?oauth_pending=<id>`.
 * Only the page the server serves gets one; the id is read once and leaves
 * the address with it.
 */
export function PendingSignInRoute({ navigate = (url) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const account = useAccountModel();
  const [id] = useState(() => oauthReturn().pending);
  const [open, setOpen] = useState(id !== undefined);
  useEffect(() => {
    if (id !== undefined) clearOAuthReturn("pending");
  }, [id]);
  if (!open || id === undefined || account.state.status === "unavailable") return null;
  const close = (): void => setOpen(false);
  return (
    <Dialog isOpen onOpenChange={(next) => (next ? undefined : close())} width={480}>
      <Layout
        header={<DialogHeader title="Finish signing in" onOpenChange={close} />}
        content={
          <LayoutContent>
            <div style={{ padding: "var(--spacing-2)" }}>
              {account.state.status === "checking" ? (
                <Spinner size="sm" />
              ) : (
                <PendingSignInSteps account={account} id={id} navigate={navigate} onDone={close} />
              )}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

/** Where a finished create or link goes: the native app's redirect, else this page, signed in. */
const finished = (
  result: AccountResult<{ redirect?: string }>,
  navigate: (url: string) => void,
  onDone: () => void,
): AccountError | undefined => {
  if (!result.ok) return result.error;
  if (result.value.redirect !== undefined) navigate(result.value.redirect);
  else onDone();
  return undefined;
};

export function PendingSignInSteps({
  account,
  id,
  navigate,
  onDone,
}: {
  account: AccountModel;
  id: string;
  navigate: (url: string) => void;
  onDone: () => void;
}) {
  const [pending, setPending] = useState<PendingSignIn | "expired">();
  const [loadError, setLoadError] = useState<AccountError>();
  const [mailsCodes, setMailsCodes] = useState<boolean>();
  // Picked when "I already have an account" is pressed: the sign-in-and-link
  // form signs this page in on the way, and must stay up until it links.
  const [choice, setChoice] = useState<"create" | "link-current" | "sign-in-and-link">("create");
  useEffect(() => {
    let live = true;
    void account.pendingSignIn(id).then((result) => {
      if (!live) return;
      if (result.ok) setPending(result.value);
      else if (result.error.code === "not_found") setPending("expired");
      else setLoadError(result.error);
    });
    void account.authMethods().then((result) => {
      if (live && result.ok) setMailsCodes(result.value.email);
    });
    return () => {
      live = false;
    };
  }, [account, id]);
  if (loadError !== undefined) {
    return <Banner status="error" title="Couldn't load this sign-in" description={accountErrorMessage(loadError)} />;
  }
  if (pending === undefined) return <Spinner size="sm" />;
  if (pending === "expired") {
    return (
      <VStack gap={3}>
        <Text>This sign-in expired. Start again.</Text>
        <HStack>
          <Button label="Back to sign-in" variant="secondary" onClick={onDone} />
        </HStack>
      </VStack>
    );
  }
  const provider = signInProviderName(pending.provider);
  return (
    <VStack gap={4}>
      {/* Whose identity this is, before anything gets attached to it. */}
      <HStack gap={3} vAlign="center">
        <SignInProviderMark provider={pending.provider} size={28} />
        <VStack gap={0}>
          <Text weight="semibold">{provider}</Text>
          <Text type="supporting">{pending.email ?? pending.name ?? "No email shared"}</Text>
        </VStack>
      </HStack>
      <Heading level={3}>No PiNomad account for {pending.email ?? `this ${provider} account`} yet</Heading>
      {choice === "create" ? (
        <CreateFromPending
          account={account}
          id={id}
          needsPassword={mailsCodes === false}
          navigate={navigate}
          onDone={onDone}
          onLink={() => setChoice(account.state.status === "signed-in" ? "link-current" : "sign-in-and-link")}
        />
      ) : choice === "link-current" && account.state.status === "signed-in" ? (
        <LinkToCurrent
          account={account}
          id={id}
          provider={provider}
          current={account.state.email ?? account.state.user}
          navigate={navigate}
          onDone={onDone}
          onBack={() => setChoice("create")}
        />
      ) : (
        <SignInAndLink account={account} id={id} provider={provider} navigate={navigate} onDone={onDone} onBack={() => setChoice("create")} />
      )}
    </VStack>
  );
}

function CreateFromPending({
  account,
  id,
  needsPassword,
  navigate,
  onDone,
  onLink,
}: {
  account: AccountModel;
  id: string;
  needsPassword: boolean;
  navigate: (url: string) => void;
  onDone: () => void;
  onLink: () => void;
}) {
  // A server that can't mail codes needs a password: the account's only way
  // to confirm changes later. It says so itself if the methods didn't.
  const [asksPassword, setAsksPassword] = useState(needsPassword);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  useEffect(() => {
    if (needsPassword) setAsksPassword(true);
  }, [needsPassword]);
  const create = (): void => {
    if (busy) return;
    if (asksPassword && passwordLength(password) < MIN_PASSWORD_LENGTH) {
      setError({ code: "weak_password" });
      return;
    }
    setBusy(true);
    setError(undefined);
    void account.createFromPending(id, asksPassword ? { password } : undefined).then((result) => {
      setBusy(false);
      if (!result.ok && result.error.code === "password_required") {
        setAsksPassword(true);
        return;
      }
      setError(finished(result, navigate, onDone));
    });
  };
  return (
    <VStack gap={3}>
      {asksPassword ? (
        <TextInput
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          onEnter={create}
          width="100%"
          {...NEW_PASSWORD_INPUT}
        />
      ) : null}
      {error === undefined ? null : <Banner status="error" title="Couldn't create the account" description={accountErrorMessage(error)} />}
      <Button
        label="Create account"
        variant="primary"
        width="100%"
        isLoading={busy}
        isDisabled={asksPassword && password === ""}
        onClick={create}
      />
      <Button label="I already have an account" variant="secondary" width="100%" isDisabled={busy} onClick={onLink} />
    </VStack>
  );
}

function LinkToCurrent({
  account,
  id,
  provider,
  current,
  navigate,
  onDone,
  onBack,
}: {
  account: AccountModel;
  id: string;
  provider: string;
  current: string;
  navigate: (url: string) => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const submit = (): void => {
    if (!identity.ready || busy) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await account.linkPending(id, confirmation.value) : confirmation;
      setBusy(false);
      if (!result.ok && result.error.code === "invalid_reauth") identity.reset();
      setError(finished(result, navigate, onDone));
    })();
  };
  const identity = useConfirmIdentity(account, submit);
  return (
    <VStack gap={3}>
      <Text>
        Link {provider} to {current}
      </Text>
      {identity.field}
      {error === undefined ? null : <Banner status="error" title={`Couldn't link ${provider}`} description={accountErrorMessage(error)} />}
      <HStack gap={2}>
        <Button label={`Link ${provider}`} variant="primary" isLoading={busy} isDisabled={!identity.ready} onClick={submit} />
        <Button label="Back" variant="secondary" onClick={onBack} />
      </HStack>
    </VStack>
  );
}

/** Not signed in: one form, two calls — sign in, then link with that same password. */
function SignInAndLink({
  account,
  id,
  provider,
  navigate,
  onDone,
  onBack,
}: {
  account: AccountModel;
  id: string;
  provider: string;
  navigate: (url: string) => void;
  onDone: () => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const ready = email.trim() !== "" && password !== "";
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    void account.signInAndLinkPending(id, { username: email.trim(), password }).then((result) => {
      setBusy(false);
      setError(finished(result, navigate, onDone));
    });
  };
  return (
    <VStack gap={3}>
      <TextInput label="Email" value={email} onChange={setEmail} onEnter={submit} width="100%" {...{ autoComplete: "username" }} />
      <TextInput
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        onEnter={submit}
        width="100%"
        {...{ autoComplete: "current-password" }}
      />
      {error === undefined ? null : <Banner status="error" title={`Couldn't link ${provider}`} description={accountErrorMessage(error)} />}
      <HStack gap={2}>
        <Button label={`Sign in and link ${provider}`} variant="primary" isLoading={busy} isDisabled={!ready} onClick={submit} />
        <Button label="Back" variant="secondary" onClick={onBack} />
      </HStack>
      <Text type="supporting">Signed up with Google, GitHub or Apple? Sign in with it first, then link this one in Settings.</Text>
    </VStack>
  );
}
