import { createContext, useContext } from "react";

/**
 * Where the popups in this folder portal to: `<body>` unless a provider says
 * otherwise. The mobile nav drawer is still Astryx's showModal() `<dialog>`
 * (ADR-0048 step 7): it sits in the top layer and makes the rest of the page
 * inert, so a menu or dialog opened from inside it must portal into it.
 */
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainer);
}
