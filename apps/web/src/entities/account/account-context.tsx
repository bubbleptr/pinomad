import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { useAccount, type AccountModel } from "./account-model.ts";

const unavailable = (): Promise<never> => Promise.reject(new Error("no AccountProvider"));

/**
 * Outside an AccountProvider there is no account: components that only
 * render account entry points (the host switcher in isolated tests) just
 * hide them instead of needing the provider's network probe.
 */
const noAccount: AccountModel = {
  state: { status: "unavailable" },
  subscribe: () => () => {},
  login: unavailable,
  register: unavailable,
  logout: unavailable,
  revokeAll: unavailable,
  changePassword: unavailable,
  deleteAccount: unavailable,
  refreshHosts: unavailable,
  createJoinToken: unavailable,
  listInvites: unavailable,
  createInvite: unavailable,
  revokeInvite: unavailable,
  pairHost: unavailable,
  retryUnsavedHost: unavailable,
  hostRejected: () => {},
};

// One model per app: every useAccount() call builds its own store and probes
// the server again, so App creates it once and deep components read it here.
// Exported so tests can provide a fake model.
export const AccountContext = createContext<AccountModel>(noAccount);

/** Must sit inside HostsContext: the model pairs into the shared host store. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const model = useAccount();
  return <AccountContext.Provider value={model}>{children}</AccountContext.Provider>;
}

/** The app's account model; the caller re-renders on every state change. */
export function useAccountModel(): AccountModel {
  const model = useContext(AccountContext);
  useSyncExternalStore(model.subscribe, () => model.state);
  return model;
}
