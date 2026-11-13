import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../../shared/ui/item.tsx";
import { Field, FieldError, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useRef, useState } from "react";
import type { AccountConfirmation, AccountError, EmailConfirmation } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { fieldErrorMessage, formErrorMessage } from "./account-error.ts";
import { CODE_INPUT } from "./code-input.ts";
import { useConfirmIdentity } from "./confirm-identity.tsx";

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
        // A refused confirmation (a spent code after its grant ran out) is
        // asked again on the save step too, where it is otherwise hidden.
        if (!confirmation.ok) setReconfirm(true);
        const onField = (sentTo === undefined || reconfirm || !confirmation.ok) && identity.claim(result.error);
        setError(onField ? undefined : result.error);
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
        <Field invalid={fieldErrorMessage(error, "email") !== undefined}>
          <FieldLabel>Email</FieldLabel>
          <Input
            type="email"
            value={email}
            onChange={(event) => {
              setError(undefined);
              setEmail(event.target.value);
            }}
            {...{ autoComplete: "email" }}
            onKeyDown={(event) => {
              if (event.key === "Enter") send();
            }}
          />
          <FieldError>{fieldErrorMessage(error, "email")}</FieldError>
        </Field>
        {identity.field}
        <FormError>{formErrorMessage(error, ["email"])}</FormError>
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
      <Field invalid={fieldErrorMessage(error, "code") !== undefined}>
        <FieldLabel>Code</FieldLabel>
        <Input
          value={code}
          onChange={(event) => {
            setError(undefined);
            setCode(event.target.value);
          }}
          {...CODE_INPUT}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
        <FieldError>{fieldErrorMessage(error, "code")}</FieldError>
      </Field>
      {/* Asked again when the server refused the grant, or it ran out here. */}
      {reconfirm || !identity.ready ? identity.field : null}
      <FormError>{formErrorMessage(error, ["code"])}</FormError>
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
      <ItemGroup>
        <Item render={<li />}>
          <ItemContent>
            <ItemTitle>{email ?? "None yet"}</ItemTitle>
            {changed ? <ItemDescription>Email saved.</ItemDescription> : null}
          </ItemContent>
          <ItemActions>
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
          </ItemActions>
        </Item>
      </ItemGroup>
      </SettingsGroup>
      {open ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setOpen(false))} disablePointerDismissal>
          <DialogContent className="w-[460px]">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <DialogBody>
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
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
