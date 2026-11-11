import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useState } from "react";
import type { AccountError, AccountResult, PendingSignIn } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { clearOAuthReturn, oauthReturn } from "../../entities/account/oauth-return.ts";
import { signInProviderName, SignInProviderMark } from "../../entities/provider/sign-in-provider.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { MIN_PASSWORD_LENGTH, NEW_PASSWORD_INPUT, passwordLength } from "./code-input.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

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
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load this sign-in</AlertTitle>
        <AlertDescription>{accountErrorMessage(loadError)}</AlertDescription>
      </Alert>
    );
  }
  if (pending === undefined) return <Spinner size="sm" />;
  if (pending === "expired") {
    return (
      <div className="flex flex-col gap-3">
        <span className="text-sm/5">This sign-in expired. Start again.</span>
        <div className="flex">
          <Button variant="secondary" onClick={onDone}>Back to sign-in</Button>
        </div>
      </div>
    );
  }
  const provider = signInProviderName(pending.provider);
  return (
    <div className="flex flex-col gap-4">
      {/* Whose identity this is, before anything gets attached to it. */}
      <div className="flex items-center gap-3">
        <SignInProviderMark provider={pending.provider} size={28} />
        <div className="flex flex-col">
          <span className="text-sm/5 font-semibold">{provider}</span>
          <span className="text-xs/5 text-muted-foreground">{pending.email ?? pending.name ?? "No email shared"}</span>
        </div>
      </div>
      <h3 className="text-[1.0625rem]/6 font-bold">No PiNomad account for {pending.email ?? `this ${provider} account`} yet</h3>
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
    </div>
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
    <div className="flex flex-col gap-3">
      {asksPassword ? (
        <Field>
          <FieldLabel>New password</FieldLabel>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...NEW_PASSWORD_INPUT}
            onKeyDown={(event) => {
              if (event.key === "Enter") create();
            }}
          />
        </Field>
      ) : null}
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't create the account</AlertTitle>
          <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <Button
        variant="primary"
        className="w-full"
        loading={busy}
        disabled={asksPassword && password === ""}
        onClick={create}
      >
        Create account
      </Button>
      <Button variant="secondary" className="w-full" disabled={busy} onClick={onLink}>I already have an account</Button>
    </div>
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
    <div className="flex flex-col gap-3">
      <span className="text-sm/5">
        Link {provider} to {current}
      </span>
      {identity.field}
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{`Couldn't link ${provider}`}</AlertTitle>
          <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="primary" loading={busy} disabled={!identity.ready} onClick={submit}>{`Link ${provider}`}</Button>
        <Button variant="secondary" onClick={onBack}>Back</Button>
      </div>
    </div>
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
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...{ autoComplete: "username" }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </Field>
      <Field>
        <FieldLabel>Password</FieldLabel>
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...{ autoComplete: "current-password" }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </Field>
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{`Couldn't link ${provider}`}</AlertTitle>
          <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>{`Sign in and link ${provider}`}</Button>
        <Button variant="secondary" onClick={onBack}>Back</Button>
      </div>
      <span className="text-xs/5 text-muted-foreground">Signed up with Google, GitHub or Apple? Sign in with it first, then link this one in Settings.</span>
    </div>
  );
}
