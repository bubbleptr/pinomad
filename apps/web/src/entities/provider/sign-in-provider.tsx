import type { CSSProperties } from "react";
import { logoSvg } from "./provider-logo.tsx";

/**
 * The account sign-in providers (ADR-0044 §3), in the order the buttons
 * show. Not the model providers in provider-logo.tsx: these are who vouches
 * for a PiNomad account.
 */
export const SIGN_IN_PROVIDERS = [
  { id: "google", name: "Google", logo: "google-color" },
  { id: "github", name: "GitHub", logo: "github" },
  { id: "apple", name: "Apple", logo: "apple" },
] as const;

/** A provider id as people say it; unknown ids pass through. */
export const signInProviderName = (id: string): string =>
  SIGN_IN_PROVIDERS.find((provider) => provider.id === id)?.name ?? id;

/** The providers a server offers that this client knows, in button order. */
export const knownSignInProviders = (offered: readonly string[]): readonly (typeof SIGN_IN_PROVIDERS)[number][] =>
  SIGN_IN_PROVIDERS.filter((provider) => offered.includes(provider.id));

/**
 * A provider's brand mark at text size, bare (no tile): it sits in a button
 * or beside the provider's name. GitHub and Apple paint with currentColor.
 */
export function SignInProviderMark({ provider, size = 16 }: { provider: string; size?: number }) {
  const entry = SIGN_IN_PROVIDERS.find((each) => each.id === provider);
  const svg = entry === undefined ? undefined : logoSvg(entry.logo);
  if (svg === undefined) return null;
  const style: CSSProperties = { display: "inline-flex", inlineSize: size, blockSize: size, flex: "none" };
  return (
    <span
      className="sign-in-provider-mark"
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg.replace(/(width|height)="1em"/g, '$1="100%"') }}
    />
  );
}
