import { Button } from "../../shared/ui/button.tsx";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useReducer, useRef, useState, type ReactElement } from "react";
import type { AccountConfirmation, AccountError, AccountResult } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { accountErrorMessage } from "./account-error.ts";
import { CODE_INPUT } from "./code-input.ts";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

/** The second check a guarded action takes, ready to send (ADR-0044 §6). */
export interface IdentityConfirmation {
  /** The field the action's form shows in place of its password input; nothing while a recent grant lasts. */
  readonly field: ReactElement | null;
  /** Enough is filled in to try. */
  readonly ready: boolean;
  /**
   * A re-auth grant: the account's last one while it lasts, else one traded
   * for the password or the mailed code. `reset` drops it after the action
   * refused it, with the spent code, so the field asks again.
   */
  confirm(): Promise<AccountResult<AccountConfirmation>>;
  reset(): void;
}

type Method = "loading" | "password" | "code";

/**
 * The confirmation kicking a device, removing a host, deleting the account
 * and changing sign-in methods ask for: the password on an account that has
 * one, else a code mailed to the account's email. Either is traded for a
 * grant the account keeps for five minutes, and every guarded action in that
 * window goes through without asking. Each action keeps its own button and
 * copy; this supplies only the value.
 */
export function useConfirmIdentity(account: AccountModel, onEnter?: () => void): IdentityConfirmation {
  const [method, setMethod] = useState<Method>("loading");
  // Read on every render: the account holds the grant, this only redraws once it changes.
  const granted = account.recentGrant() !== undefined;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<AccountError>();
  // Closed while the password was checked: the action must not go ahead.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void account.identities().then((result) => {
      // A server that can't list them (an older one) still takes the password.
      if (live) setMethod(result.ok && !result.value.hasPassword ? "code" : "password");
    });
    return () => {
      live = false;
    };
  }, [account]);
  const email = account.state.status === "signed-in" ? account.state.email : undefined;
  const send = (): void => {
    if (sending) return;
    setSending(true);
    setSendError(undefined);
    void account.requestReauthCode().then((result) => {
      setSending(false);
      if (result.ok) setSent(true);
      else setSendError(result.error);
    });
  };
  const field = granted ? null : (
    <ConfirmIdentity
      method={method}
      email={email}
      password={password}
      onPassword={setPassword}
      code={code}
      onCode={setCode}
      sent={sent}
      sending={sending}
      sendError={sendError}
      onSend={send}
      onEnter={onEnter}
    />
  );
  return {
    field,
    ready: granted || (method === "password" ? password !== "" : method === "code" && sent && code.trim() !== ""),
    confirm: async () => {
      const held = account.recentGrant();
      if (held !== undefined) return { ok: true, value: held };
      // It ran out while the dialog was open: ask now.
      if (granted) {
        redraw();
        return { ok: false, error: { code: "invalid_reauth" } };
      }
      const result = await account.reauth(method === "password" ? { password } : { code: code.trim() });
      if (!live.current) return { ok: false, error: { code: "cancelled" } };
      // A server without grants takes the password on the action itself.
      if (!result.ok && method === "password" && result.error.status === 404) return { ok: true, value: password };
      if (!result.ok) return result;
      redraw();
      return { ok: true, value: { reauth: result.value.reauth } };
    },
    reset: () => {
      account.forgetGrant();
      redraw();
      setPassword("");
      setCode("");
      setSent(false);
    },
  };
}

/** The confirmation field as it renders; `useConfirmIdentity` holds its state. */
export function ConfirmIdentity({
  method,
  email,
  password,
  onPassword,
  code,
  onCode,
  sent,
  sending,
  sendError,
  onSend,
  onEnter,
}: {
  method: Method;
  email: string | undefined;
  password: string;
  onPassword: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
  sent: boolean;
  sending: boolean;
  sendError: AccountError | undefined;
  onSend: () => void;
  onEnter?: (() => void) | undefined;
}) {
  if (method === "loading") return <Spinner size="sm" />;
  if (method === "password") {
    return (
      <Field>
        <FieldLabel>Password</FieldLabel>
        <Input
          type="password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          {...{ autoComplete: "current-password" }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter?.();
          }}
        />
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs/5 text-muted-foreground">We'll email a code to {email ?? "your account's email"}.</span>
      {sent ? (
        <Field>
          <FieldLabel>Confirmation code</FieldLabel>
          <Input
            value={code}
            onChange={(event) => onCode(event.target.value)}
            {...CODE_INPUT}
            onKeyDown={(event) => {
              if (event.key === "Enter") onEnter?.();
            }}
          />
        </Field>
      ) : null}
      {sendError === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't send the code</AlertTitle>
          <AlertDescription>{accountErrorMessage(sendError)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" loading={sending} onClick={onSend}>{sent ? "Resend code" : "Send code"}</Button>
      </div>
    </div>
  );
}
