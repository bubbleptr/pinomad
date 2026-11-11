import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "../../shared/ui/button.tsx";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AccountConfirmation, AccountError, AccountResult } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { accountErrorMessage } from "./account-error.ts";
import { CODE_INPUT } from "./code-input.ts";

/** The second check a guarded action takes, ready to send (ADR-0044 §6). */
export interface IdentityConfirmation {
  /** The field the action's form shows in place of its password input. */
  readonly field: ReactElement;
  /** Enough is filled in to try. */
  readonly ready: boolean;
  /**
   * The password, or a re-auth grant traded for the mailed code. A grant is
   * kept for the next try; `reset` drops it after the action refused it,
   * with the spent code, so a passwordless account sends a new one.
   */
  confirm(): Promise<AccountResult<AccountConfirmation>>;
  reset(): void;
}

type Method = "loading" | "password" | "code";

/**
 * The confirmation kicking a device, removing a host, deleting the account
 * and changing sign-in methods ask for: the password on an account that has
 * one, else a code mailed to the account's email. Each action keeps its own
 * button and copy; this supplies only the value.
 */
export function useConfirmIdentity(account: AccountModel, onEnter?: () => void): IdentityConfirmation {
  const [method, setMethod] = useState<Method>("loading");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<AccountError>();
  const grant = useRef<{ readonly reauth: string }>(undefined);
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
  const field = (
    <ConfirmIdentity
      method={method}
      email={email}
      password={password}
      onPassword={setPassword}
      code={code}
      onCode={(value) => {
        grant.current = undefined;
        setCode(value);
      }}
      sent={sent}
      sending={sending}
      sendError={sendError}
      onSend={send}
      onEnter={onEnter}
    />
  );
  return {
    field,
    ready: method === "password" ? password !== "" : method === "code" && sent && code.trim() !== "",
    confirm: async () => {
      if (method === "password") return { ok: true, value: password };
      if (grant.current !== undefined) return { ok: true, value: grant.current };
      const result = await account.reauth({ code: code.trim() });
      if (!result.ok) return result;
      grant.current = { reauth: result.value.reauth };
      return { ok: true, value: grant.current };
    },
    reset: () => {
      grant.current = undefined;
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
        <Banner status="error" title="Couldn't send the code" description={accountErrorMessage(sendError)} />
      )}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" loading={sending} onClick={onSend}>{sent ? "Resend code" : "Send code"}</Button>
      </div>
    </div>
  );
}
