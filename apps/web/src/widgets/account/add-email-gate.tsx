import { Button } from "../../shared/ui/button.tsx";
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
    <div className="flex flex-col gap-4" style={{ width: "100%", maxWidth: 420 }}>
      <div className="flex flex-col gap-1">
        <h3 className="text-[1.0625rem]/6 font-bold">Add an email to your account</h3>
        <span className="text-xs/5 text-muted-foreground">You'll sign in with it from now on, and sign-in codes go there.</span>
      </div>
      <EmailForm account={account} submitLabel="Save" onSaved={() => {}} />
      <div className="flex">
        <Button variant="secondary" onClick={() => void account.logout()}>Sign out</Button>
      </div>
    </div>
  );
}
