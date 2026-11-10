import { createContext, useContext, useEffect } from "react";

/** A page a Settings section opened inside itself, such as one host's page. */
export interface SettingsSubpage {
  readonly title: string;
  readonly back: () => void;
}

interface SettingsSubpageHost {
  /** The Settings header carries the way back (the compact layout); the section shows none of its own. */
  readonly ownsBack: boolean;
  readonly set: (page: SettingsSubpage | undefined) => void;
}

export const SettingsSubpageContext = createContext<SettingsSubpageHost | undefined>(undefined);

/**
 * Report an open sub-page to the enclosing Settings page, so its header
 * names it and its back button closes it before leaving the section. Returns
 * whether the section should leave out its own back button.
 */
export function useSettingsSubpage(page: SettingsSubpage | undefined): boolean {
  const host = useContext(SettingsSubpageContext);
  const title = page?.title;
  const back = page?.back;
  useEffect(() => {
    if (host === undefined || title === undefined || back === undefined) return;
    host.set({ title, back });
    return () => host.set(undefined);
  }, [host, title, back]);
  return host?.ownsBack === true;
}
