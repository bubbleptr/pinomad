import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import type { AccountConfirmation, AccountError, EmailConfirmation } from "@pinomad/client/account.ts";
import type { AccountModel } from "../../entities/account/account-model.ts";
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
  const run = (call: (confirmation: EmailConfirmation) => Promise<{ ok: true } | { ok: false; error: AccountError }>, then: () => void): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      const confirmation = await identity.confirm();
      const result = confirmation.ok ? await call(byName(confirmation.value)) : confirmation;
      setBusy(false);
      if (result.ok) then();
      else {
        if (result.error.code === "invalid_reauth") identity.reset();
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
    if (sentTo === undefined || code.trim() === "" || busy) return;
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
          <Button label="Send code" variant="primary" isLoading={busy} isDisabled={email.trim() === "" || !identity.ready} onClick={send} />
          {cancel}
        </HStack>
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
      <Text>Enter the 6-digit code we sent to {sentTo}.</Text>
      <TextInput label="Code" value={code} onChange={setCode} onEnter={save} width="100%" {...CODE_INPUT} />
      {error === undefined ? null : <Banner status="error" title="Couldn't save the email" description={accountErrorMessage(error)} />}
      <HStack gap={2}>
        <Button label={submitLabel} variant="primary" isLoading={busy} isDisabled={code.trim() === ""} onClick={save} />
        <Button
          label="Use a different email"
          variant="ghost"
          onClick={() => {
            setSentTo(undefined);
            setCode("");
            setError(undefined);
          }}
        />
      </HStack>
    </VStack>
  );
}

/** The account's email, with "Change email" opening the form in place. */
export function AccountEmail({ account, email }: { account: AccountModel; email: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  if (open) {
    return (
      <VStack gap={2}>
        <Text weight="semibold">Change email</Text>
        <EmailForm
          account={account}
          submitLabel="Save"
          onSaved={() => {
            setOpen(false);
            setChanged(true);
          }}
          onCancel={() => setOpen(false)}
        />
      </VStack>
    );
  }
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" hAlign="between">
        <VStack gap={0}>
          <Text weight="semibold">Email</Text>
          <Text type="supporting">{email ?? "None yet"}</Text>
        </VStack>
        <Button
          label={email === undefined ? "Add email" : "Change email"}
          variant="secondary"
          size="sm"
          onClick={() => {
            setChanged(false);
            setOpen(true);
          }}
        />
      </HStack>
      {changed ? <Text type="supporting">Email saved.</Text> : null}
    </VStack>
  );
}
