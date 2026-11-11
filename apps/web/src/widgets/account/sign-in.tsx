import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "../../shared/ui/button.tsx";
import { Separator } from "../../shared/ui/separator.tsx";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useState } from "react";
import { isSecureServerOrigin, type AccountError, type AccountResult, type AuthMethods } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { knownSignInProviders, SignInProviderMark } from "../../entities/provider/sign-in-provider.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { CODE_INPUT, MIN_PASSWORD_LENGTH, NEW_PASSWORD_INPUT, passwordLength } from "./code-input.ts";

/** The Server field's value and setter; absent on a cookie page, which is the server. */
export interface ServerField {
  readonly origin: string;
  readonly setOrigin: (origin: string) => void;
}

type Step = "sign-in" | "create" | "reset";

interface Notice {
  readonly status: "success" | "error";
  readonly title: string;
  readonly description: string;
}

/** How long Resend code waits after a send. */
export const RESEND_COOLDOWN_MS = 30_000;

/**
 * GET /api/auth/methods for the server this screen signs in to: the page's
 * own once, or in bearer mode the typed one once it's a TLS origin and has
 * stopped changing. Undefined until it answers, and on failure: the email
 * form still works without it.
 */
function useAuthMethods(account: AccountModel, serverOrigin: string | undefined): AuthMethods | undefined {
  const [answer, setAnswer] = useState<{ readonly key: string; readonly methods: AuthMethods }>();
  const key = serverOrigin?.trim() ?? "";
  const asks = serverOrigin === undefined || isSecureServerOrigin(key);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    const timer = setTimeout(
      () => {
        void account.authMethods(serverOrigin === undefined ? undefined : key).then((result) => {
          if (live && result.ok) setAnswer({ key, methods: result.value });
        });
      },
      serverOrigin === undefined ? 0 : 400,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [account, asks, key, serverOrigin]);
  return answer?.key === key ? answer.methods : undefined;
}

/**
 * The signed-out screen (ADR-0044): provider buttons where the server offers
 * them and this client can run the flow, then email and password; creating
 * an account and resetting a password are steps of their own. Legacy
 * accounts sign in with their username in the Email field.
 */
export function SignInScreen({
  account,
  server,
  initialError,
}: {
  account: AccountModel;
  server?: ServerField | undefined;
  /** A provider sign-in's `?oauth_error=` reason. */
  initialError?: string | undefined;
}) {
  const [step, setStep] = useState<Step>("sign-in");
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<Notice | undefined>(() =>
    initialError === undefined
      ? undefined
      : { status: "error", title: "Couldn't sign in", description: accountErrorMessage({ code: initialError }) },
  );
  const methods = useAuthMethods(account, server?.origin);
  const serverOrigin = server === undefined ? undefined : server.origin.trim();
  const target = serverOrigin === undefined ? {} : { serverOrigin };
  const go = (next: Step): void => {
    setNotice(undefined);
    setStep(next);
  };
  const heading = { "sign-in": "Sign in", create: "Create an account", reset: "Reset your password" }[step];
  return (
    <div className="flex flex-col gap-3" style={{ width: "100%" }}>
      <div className="flex flex-col gap-1">
        <h3 className="text-[1.0625rem]/6 font-bold">{heading}</h3>
        {step === "sign-in" ? (
          <span className="text-xs/5 text-muted-foreground">See the hosts on your account and connect without a QR code.</span>
        ) : null}
      </div>
      {notice === undefined ? null : <Banner status={notice.status} title={notice.title} description={notice.description} />}
      {server === undefined ? null : (
        <Field>
          <FieldLabel>Server</FieldLabel>
          <Input
            placeholder="https://nomad.example.com"
            value={server.origin}
            onChange={(event) => server.setOrigin(event.target.value)}
            {...{ autoComplete: "url" }}
          />
        </Field>
      )}
      {step === "sign-in" ? (
        <SignInStep
          account={account}
          methods={methods}
          email={email}
          onEmail={setEmail}
          target={target}
          onStep={go}
          onError={(error) => setNotice(error === undefined ? undefined : { status: "error", title: "Couldn't sign in", description: accountErrorMessage(error) })}
        />
      ) : (
        <CodeFlow
          key={step}
          kind={step}
          email={email}
          onEmail={setEmail}
          send={(address) =>
            step === "create"
              ? account.requestSignupCode({ email: address, ...target })
              : account.requestPasswordReset({ email: address, ...target })
          }
          finish={(address, code, password) =>
            step === "create"
              ? account.register({ email: address, code, password, ...target })
              : account.resetPassword({ email: address, code, password, ...target })
          }
          onDone={() => {
            if (step === "reset") {
              setStep("sign-in");
              setNotice({ status: "success", title: "Password reset", description: "Password reset. Sign in with your new password." });
            }
          }}
          onBack={() => go("sign-in")}
        />
      )}
    </div>
  );
}

function SignInStep({
  account,
  methods,
  email,
  onEmail,
  target,
  onStep,
  onError,
}: {
  account: AccountModel;
  methods: AuthMethods | undefined;
  email: string;
  onEmail: (email: string) => void;
  target: { serverOrigin?: string };
  onStep: (step: Step) => void;
  onError: (error: AccountError | undefined) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string>();
  const providers = account.providerFlow === undefined ? [] : knownSignInProviders(methods?.providers ?? []);
  const needsOrigin = "serverOrigin" in target && target.serverOrigin === "";
  const ready = email.trim() !== "" && password !== "" && !needsOrigin;
  const settle = (result: AccountResult<void>): void => {
    setBusy(undefined);
    if (!result.ok) onError(result.error);
  };
  const submit = (): void => {
    if (!ready || busy !== undefined) return;
    setBusy("password");
    onError(undefined);
    void account.login({ username: email.trim(), password, ...target }).then(settle);
  };
  const withProvider = (provider: string): void => {
    if (busy !== undefined) return;
    setBusy(provider);
    onError(undefined);
    void account.providerSignIn({ provider, ...target }).then(settle);
  };
  return (
    <div className="flex flex-col gap-3">
      {providers.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant="secondary"
              className="w-full"
              loading={busy === provider.id}
              disabled={busy !== undefined && busy !== provider.id}
              onClick={() => withProvider(provider.id)}
            >
              <SignInProviderMark provider={provider.id} />
              {`Continue with ${provider.name}`}
            </Button>
          ))}
          <div className="flex items-center w-full text-xs/5 text-muted-foreground">
            <Separator className="flex-1" />
            <span className="shrink-0 px-3">or</span>
            <Separator className="flex-1" />
          </div>
        </div>
      )}
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input
          value={email}
          onChange={(event) => onEmail(event.target.value)}
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
      <Button variant="primary" className="w-full" loading={busy === "password"} disabled={!ready} onClick={submit}>Sign in</Button>
      {methods?.email !== true ? null : (
        <div className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => onStep("reset")}>Forgot password?</Button>
          {methods.registration ? (
            <Button variant="ghost" size="sm" onClick={() => onStep("create")}>Create an account</Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * A mailed-code flow in two steps, shared by sign-up and password reset:
 * the email and Send code, then the code and a new password.
 */
function CodeFlow({
  kind,
  email,
  onEmail,
  send,
  finish,
  onDone,
  onBack,
}: {
  kind: "create" | "reset";
  email: string;
  onEmail: (email: string) => void;
  send: (email: string) => Promise<AccountResult<void>>;
  finish: (email: string, code: string, password: string) => Promise<AccountResult<void>>;
  onDone: () => void;
  onBack: () => void;
}) {
  const [sentTo, setSentTo] = useState<string>();
  const [sentAt, setSentAt] = useState(0);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  const now = useTicker(sentTo !== undefined && Date.now() - sentAt < RESEND_COOLDOWN_MS);
  const wait = Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - now) / 1000));
  const sendCode = (address: string): void => {
    if (address === "" || busy) return;
    setBusy(true);
    setError(undefined);
    void send(address).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSentTo(address);
      setSentAt(Date.now());
    });
  };
  const submit = (): void => {
    if (sentTo === undefined || code.trim() === "" || password === "" || busy) return;
    if (passwordLength(password) < MIN_PASSWORD_LENGTH) {
      setError({ code: "weak_password" });
      return;
    }
    setBusy(true);
    setError(undefined);
    void finish(sentTo, code.trim(), password).then((result) => {
      setBusy(false);
      if (result.ok) onDone();
      else setError(result.error);
    });
  };
  const errorBanner =
    error === undefined ? null : (
      <Banner
        status="error"
        title={sentTo === undefined ? "Couldn't send the code" : kind === "create" ? "Couldn't create the account" : "Couldn't reset the password"}
        description={accountErrorMessage(error)}
      />
    );
  if (sentTo === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input
            type="email"
            value={email}
            onChange={(event) => onEmail(event.target.value)}
            {...{ autoComplete: "email" }}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendCode(email.trim());
            }}
          />
        </Field>
        {errorBanner}
        <Button variant="primary" className="w-full" loading={busy} disabled={email.trim() === ""} onClick={() => sendCode(email.trim())}>Send code</Button>
        <div className="flex">
          <Button variant="ghost" size="sm" onClick={onBack}>Sign in instead</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm/5">Enter the 6-digit code we sent to {sentTo}.</span>
      <Field>
        <FieldLabel>Code</FieldLabel>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          {...CODE_INPUT}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </Field>
      <Field>
        <FieldLabel>New password</FieldLabel>
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...NEW_PASSWORD_INPUT}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </Field>
      {errorBanner}
      <Button
        variant="primary"
        className="w-full"
        loading={busy}
        disabled={code.trim() === "" || password === ""}
        onClick={submit}
      >
        {kind === "create" ? "Create account" : "Reset password"}
      </Button>
      <div className="flex justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={wait > 0 || busy}
          onClick={() => sendCode(sentTo)}
        >
          {wait > 0 ? `Resend code (${wait}s)` : "Resend code"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSentTo(undefined);
            setCode("");
            setError(undefined);
          }}
        >
          Use a different email
        </Button>
      </div>
    </div>
  );
}

/** Date.now(), re-rendered every second while `active`. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
