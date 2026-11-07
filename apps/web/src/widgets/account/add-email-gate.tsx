import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import type { AccountModel } from "../../entities/account/account-model.ts";
import { Centered } from "../../shared/ui/centered.tsx";
import { EmailForm } from "./account-email.tsx";

/**
 * Holds the app back while the signed-in account is a legacy one the server
 * wants an email for (ADR-0044 §8): the card in its place until the email is
 * saved, which ends the hold in the model.
 */
export function AddEmailGate({ children }: { children: ReactNode }) {
  const account = useAccountModel();
  if (account.state.status !== "signed-in" || account.state.needsEmail !== true) return <>{children}</>;
  return (
    <Centered>
      <AddEmailCard account={account} />
    </Centered>
  );
}

export function AddEmailCard({ account }: { account: AccountModel }) {
  return (
    <VStack gap={4} style={{ width: "100%", maxWidth: 420 }}>
      <VStack gap={1}>
        <Heading level={3}>Add an email to your account</Heading>
        <Text type="supporting">You'll sign in with it from now on, and sign-in codes go there.</Text>
      </VStack>
      <EmailForm account={account} submitLabel="Save" onSaved={() => {}} />
      <HStack>
        <Button label="Sign out" variant="secondary" onClick={() => void account.logout()} />
      </HStack>
    </VStack>
  );
}
