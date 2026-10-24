/** A provider with a credential stored on the host (`<dataDir>/auth.json`); env-var or ambient auth is not listed. */
export interface StoredLogin {
  readonly providerId: string;
  /** The provider's display name, falling back to `providerId`. */
  readonly name: string;
  /** pi-ai's `Credential["type"]`: today exactly these two, kept verbatim. */
  readonly kind: "oauth" | "api_key";
  /** Whether the credential is a provider subscription (e.g. OAuth plans), per the host. */
  readonly subscription: boolean;
}

/** Which providers hold stored credentials on the host; pushed whole on change (ADR-0021 §6). */
export interface HostAuth {
  /** Sorted by `providerId`. */
  readonly logins: readonly StoredLogin[];
}

/** How a login is done: pi-ai's `AuthType`. */
export type LoginMethod = "oauth" | "api_key";

/** The wire formats a custom endpoint may speak (a subset of pi-ai's `KnownApi`). */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export const isCustomProviderApi = (value: unknown): value is CustomProviderApi =>
  (CUSTOM_PROVIDER_APIS as readonly unknown[]).includes(value);

/** An endpoint the user added (ADR-0031): stored in `<dataDir>/models.json`, its key in `auth.json`. */
export interface CustomProvider {
  readonly api: CustomProviderApi;
  readonly baseUrl: string;
  /** Model ids as the endpoint names them, in the user's order. */
  readonly models: readonly string[];
}

/** `saveCustomProvider`'s argument: a new endpoint, or a replacement for the one with this `id`. */
export interface CustomProviderInput extends CustomProvider {
  /** Lowercase letters, digits and `-`; must not name a built-in provider. */
  readonly id: string;
  readonly name: string;
}

/** One provider the host can reach models through (5.21). */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  /** Sign-in through the provider's site (pi-ai's `Provider.auth.oauth`). */
  readonly oauth?: {
    /** pi's label for the method, e.g. "Anthropic (Claude Pro/Max)". */
    readonly name: string;
    /** Whether the sign-in uses a plan the user pays for, not per-token billing. */
    readonly subscription: boolean;
    /** The provider's wording for the sign-in button, e.g. "Sign in with ChatGPT". */
    readonly loginLabel?: string;
  };
  /** Login by pasting a key (and any provider settings pi asks for). */
  readonly apiKey?: { readonly name: string };
  /** The credential stored on the host for this provider — at most one. */
  readonly stored?: { readonly kind: LoginMethod; readonly subscription: boolean };
  /**
   * Where requests get auth when nothing is stored, e.g. `GEMINI_API_KEY`
   * from the host's environment; absent when nothing ambient configures it.
   */
  readonly ambient?: string;
  /** Present exactly for endpoints the user added. */
  readonly custom?: CustomProvider;
}

/** Something a login wants the user to see; pi-ai's `AuthEvent`. */
export type LoginEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      /** Epoch ms after which the code stops working. */
      readonly expiresAt?: number;
    }
  | { readonly type: "progress"; readonly message: string };

/** Input a login waits for; pi-ai's `AuthPrompt` with an id `answerLogin` names. */
export type LoginPrompt = { readonly id: number } & (
  | { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    }
);

/**
 * One login in progress or just ended. Host-wide like the credentials it
 * writes; a finished flow stays listed briefly so its outcome reaches the
 * device that started it. Answers are never echoed back.
 */
export interface LoginFlow {
  readonly id: string;
  readonly providerId: string;
  readonly method: LoginMethod;
  /** Oldest first. */
  readonly events: readonly LoginEvent[];
  /** Set while the login waits for an answer. */
  readonly prompt?: LoginPrompt;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  /** Why the login failed; set exactly when `state` is `"failed"`. */
  readonly error?: string;
}

/** The `providers` host stream (5.21, ADR-0031): every provider and the logins in progress. */
export interface HostProviders {
  /** Built-in providers by name, then custom endpoints by name. */
  readonly providers: readonly ProviderInfo[];
  readonly logins: readonly LoginFlow[];
}
