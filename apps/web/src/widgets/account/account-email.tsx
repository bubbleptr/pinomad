import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import type { AccountConfirmation, AccountError, EmailConfirmation } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { SettingsGroup } from "../../shared/ui/settings-group.tsx";
import { accountErrorMessage } from "./account-error.ts";
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
  const run = (call: (confirmation: EmailConfirmation) => Promise<{ ok: true } | { ok: false; error: AccountError }>, then: () => void): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await call(byName(confirmation.value)) : confirmation;
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
  const cancel = onCancel === undefined ? null : <Button label="Cancel" variant="secondary" onClick={onCancel} />;
  if (sentTo === undefined) {
    return (
      <VStack gap={2}>
        <TextInput label="Email" type="email" value={email} onChange={setEmail} onEnter={send} width="100%" {...{ autoComplete: "email" }} />
        {identity.field}
        {error === undefined ? null : <Banner status="error" title="Couldn't send the code" description={accountErrorMessage(error)} />}
        <HStack gap={2}>
          <Button label="Send code to new email" variant="primary" isLoading={busy} isDisabled={email.trim() === "" || !identity.ready} onClick={send} />
          {cancel}
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
      <Text>Enter the 6-digit code we sent to {sentTo}.</Text>
      <TextInput label="Code" value={code} onChange={setCode} onEnter={save} width="100%" {...CODE_INPUT} />
      {reconfirm ? identity.field : null}
      {error === undefined ? null : <Banner status="error" title="Couldn't save the email" description={accountErrorMessage(error)} />}
      <HStack gap={2}>
        <Button label={submitLabel} variant="primary" isLoading={busy} isDisabled={code.trim() === "" || !identity.ready} onClick={save} />
        <Button
          label="Use a different email"
          variant="ghost"
          onClick={() => {
            setSentTo(undefined);
            setCode("");
            setError(undefined);
            setReconfirm(false);
          }}
        />
      </HStack>
    </VStack>
  );
}

/** The account's email, with Change… opening the form in a dialog. */
export function AccountEmail({ account, email }: { account: AccountModel; email: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  const title = email === undefined ? "Add email" : "Change email";
  return (
    <VStack gap={2}>
      <SettingsGroup title="Email">
      <List aria-label="Email">
        <ListItem
          label={email ?? "None yet"}
          {...(changed ? { description: "Email saved." } : {})}
          endContent={
            <Button
              label={email === undefined ? "Add…" : "Change…"}
              aria-label={`${title}…`}
              variant="secondary"
              size="sm"
              onClick={() => {
                setChanged(false);
                setOpen(true);
              }}
            />
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
    </VStack>
  );
}
