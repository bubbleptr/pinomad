/** A provider with a credential stored on the host (pi's auth.json); env-var or ambient auth is not listed. */
export interface StoredLogin {
  readonly providerId: string;
  /** The provider's display name, falling back to `providerId`. */
  readonly name: string;
  /** pi-ai's `Credential["type"]`: today exactly these two, kept verbatim. */
  readonly kind: "oauth" | "api_key";
  /** Whether the credential is a provider subscription (e.g. OAuth plans), per the host. */
  readonly subscription: boolean;
}

/** Which providers hold stored credentials on the host; pushed whole on change (ADR-0021 §5). */
export interface HostAuth {
  /** Sorted by `providerId`. */
  readonly logins: readonly StoredLogin[];
}
