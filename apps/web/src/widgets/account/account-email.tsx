import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useRef, useState } from "react";
import type { AccountConfirmation, AccountError, EmailConfirmation } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { accountErrorMessage } from "./account-error.ts";
import { CODE_INPUT } from "./code-input.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";

const byName = (confirmation: AccountConfirmation): EmailConfirmation =>
  typeof confirmation === "string" ? { password: confirmation } : confirmation;

/**
 * Setting the account's email (ADR-0044 §8): confirmed like any account
 * change, then a code mailed to the new address. Used for "Change email" and
 * for the email a legacy account must add before going on.
 */
export function EmailForm({
  account,
  submitLabel,
  onSaved,
  onCancel,
}: {
  account: AccountModel;
  submitLabel: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountError>();
  // The grant lapsed after the new address got its code: confirm again on this step.
  const [reconfirm, setReconfirm] = useState(false);
  // A save can land after the dialog closed and a new form opened: only a
  // form still on screen may act on its result (dureview #642).
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = (call: (confirmation: EmailConfirmation) => Promise<{ ok: true } | { ok: false; error: AccountError }>, then: () => void): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await call(byName(confirmation.value)) : confirmation;
      if (!live.current) return;
      setBusy(false);
      if (result.ok) then();
      else {
        if (result.error.code === "invalid_reauth") {
          identity.reset();
          setReconfirm(true);
        }
        setError(result.error);
      }
    })();
  };
  const send = (): void => {
    const address = email.trim();
    if (address === "" || !identity.ready || busy) return;
    run(
      (confirmation) => account.requestEmailCode({ email: address, ...confirmation }),
      () => setSentTo(address),
    );
  };
  const save = (): void => {
    if (sentTo === undefined || code.trim() === "" || !identity.ready || busy) return;
    run((confirmation) => account.setEmail({ email: sentTo, code: code.trim(), ...confirmation }), onSaved);
  };
  const identity = useConfirmIdentity(account, sentTo === undefined ? send : save);
  const cancel = onCancel === undefined ? null : <Button variant="secondary" onClick={onCancel}>Cancel</Button>;
  if (sentTo === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...{ autoComplete: "email" }}
            onKeyDown={(event) => {
              if (event.key === "Enter") send();
            }}
          />
        </Field>
        {identity.field}
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Couldn't send the code</AlertTitle>
            <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button variant="primary" loading={busy} disabled={email.trim() === "" || !identity.ready} onClick={send}>Send code to new email</Button>
          {cancel}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm/5">Enter the 6-digit code we sent to {sentTo}.</span>
      <Field>
        <FieldLabel>Code</FieldLabel>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          {...CODE_INPUT}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
      </Field>
      {reconfirm ? identity.field : null}
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't save the email</AlertTitle>
          <AlertDescription>{accountErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="primary" loading={busy} disabled={code.trim() === "" || !identity.ready} onClick={save}>{submitLabel}</Button>
        <Button
          variant="ghost"
          onClick={() => {
            setSentTo(undefined);
            setCode("");
            setError(undefined);
            setReconfirm(false);
          }}
        >
          Use a different email
        </Button>
      </div>
    </div>
  );
}

/** The account's email, with Change opening the form in a dialog. */
export function AccountEmail({ account, email }: { account: AccountModel; email: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  const title = email === undefined ? "Add email" : "Change email";
  return (
    <div className="flex flex-col gap-2">
      <SettingsGroup title="Email">
      <List aria-label="Email">
        <ListItem
          label={email ?? "None yet"}
          {...(changed ? { description: "Email saved." } : {})}
          endContent={
            <Button
              aria-label={title}
              variant="secondary"
              size="sm"
              onClick={() => {
                setChanged(false);
                setOpen(true);
              }}
            >
              {email === undefined ? "Add" : "Change"}
            </Button>
          }
        />
      </List>
      </SettingsGroup>
      {open ? (
        <Dialog aria-label={title} isOpen onOpenChange={(next) => (next ? undefined : setOpen(false))} purpose="form" width={460}>
          <Layout
            header={<DialogHeader title={title} onOpenChange={() => setOpen(false)} />}
            content={
              <LayoutContent>
                <div style={{ padding: "var(--spacing-2)" }}>
                  <EmailForm
                    account={account}
                    submitLabel="Save"
                    onSaved={() => {
                      setOpen(false);
                      setChanged(true);
                    }}
                    onCancel={() => setOpen(false)}
                  />
                </div>
              </LayoutContent>
            }
          />
        </Dialog>
      ) : null}
    </div>
  );
}
