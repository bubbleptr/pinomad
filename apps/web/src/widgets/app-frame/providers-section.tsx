import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HostProviders, LoginMethod, ProviderInfo, StoredLogin } from "@pinomad/protocol/auth.ts";
import { hostSupportsCall } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ProviderLogo } from "../../entities/provider/provider-logo.tsx";
import { ArrowLeft, ChevronRight, MoreHorizontal } from "../../shared/ui/icons.tsx";
import { CustomEndpointForm } from "./custom-endpoint-form.tsx";
import { InlineError, LoginPanel } from "./provider-login.tsx";

type OAuth = NonNullable<ProviderInfo["oauth"]>;

/**
 * What the user signs in with — the plan, not the provider. pi names its
 * OAuth methods "Anthropic (Claude Pro/Max)" or "Meta (Muse subscription)":
 * the parenthesized part without a trailing "subscription", else the whole name.
 */
const planOf = (oauth: OAuth): string => {
  const match = /^(.*?)\s*\((.+)\)\s*$/.exec(oauth.name);
  if (match === null) return oauth.name;
  const inner = match[2]!.replace(/\s*subscription$/i, "").trim();
  return inner === "" ? match[1]! : inner;
};

/** A subscription's caption beside its provider's name, where repeating the name (GitHub Copilot) says nothing. */
const planCaption = (provider: ProviderInfo): string => {
  const plan = planOf(provider.oauth!);
  return plan === provider.name ? "Subscription" : plan;
};

/** The one line under a connected provider's name. The host sends no account or key details, so none are shown. */
const credentialLine = (provider: ProviderInfo): string => {
  const custom = provider.custom;
  if (custom !== undefined) return `${custom.models.length} model${custom.models.length === 1 ? "" : "s"} · ${custom.baseUrl}`;
  const stored = provider.stored;
  if (stored === undefined) return `From the host's environment · ${provider.ambient ?? ""}`;
  if (stored.kind === "api_key") return "API key";
  return stored.subscription && provider.oauth !== undefined ? `${planOf(provider.oauth)} subscription` : "Signed in";
};

const isConnected = (provider: ProviderInfo): boolean =>
  provider.stored !== undefined || provider.ambient !== undefined || provider.custom !== undefined;

type Page =
  | { at: "home" }
  | { at: "subscription" }
  | { at: "key" }
  | { at: "custom"; id?: string }
  | { at: "provider"; id: string; method?: LoginMethod; from: Page };

const HOME: Page = { at: "home" };

const chevron = (
  <ChevronRight aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)", color: "var(--color-text-secondary)" }} />
);

/**
 * Settings → Providers (ADR-0031): what's connected, then three ways to add
 * one — subscription, API key, custom endpoint. Each pushes a page inside
 * the section; everything shown comes from the `providers` stream, so a
 * login finished on another device appears here the moment the host
 * pushes it. A host older than 5.21 only lists its stored logins.
 */
export function ProvidersSection({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const connected = view.connection === "connected";
  if (view.providers !== null) return <ProviderPages providers={view.providers} remote={remote} connected={connected} />;
  if (view.auth === null) {
    return <Banner status="warning" title="This host is too old for logins" description="Run `pinomad upgrade` on the host." />;
  }
  // A 5.21 host sends the providers snapshot right after connecting.
  if (hostSupportsCall(view.host?.protocol.minor ?? 0, "beginLogin")) return <Text as="p" type="supporting">Loading…</Text>;
  return (
    <VStack gap={3}>
      <Banner status="warning" title="Run `pinomad upgrade` on the host to add providers here" />
      {view.auth.logins.length === 0 ? (
        <Text as="p" type="supporting">No stored logins.</Text>
      ) : (
        view.auth.logins.map((login) => <StoredLoginCard key={login.providerId} login={login} connected={connected} remote={remote} />)
      )}
    </VStack>
  );
}

function ProviderPages({ providers, remote, connected }: { providers: HostProviders; remote: RemoteDurable; connected: boolean }) {
  const [page, setPage] = useState<Page>(HOME);
  const home = (): void => setPage(HOME);
  const top = useRef<HTMLDivElement>(null);
  // A pushed page starts at its top, like a navigation push.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    top.current?.scrollIntoView({ block: "nearest" });
  }, [page]);

  const byId = (id: string | undefined): ProviderInfo | undefined =>
    id === undefined ? undefined : providers.providers.find((provider) => provider.id === id);
  // A provider removed elsewhere (another device, a hand edit) takes its page with it.
  const gone = (page.at === "provider" || (page.at === "custom" && page.id !== undefined)) && byId(page.id) === undefined;
  useEffect(() => {
    if (gone) setPage(HOME);
  }, [gone]);

  let body: ReactNode;
  switch (gone ? "home" : page.at) {
    case "home":
      body = <Home providers={providers.providers} connected={connected} go={setPage} />;
      break;
    case "subscription":
      body = (
        <SubscriptionPage providers={providers.providers} connected={connected} onBack={home} onPick={(id) => setPage({ at: "provider", id, method: "oauth", from: page })} />
      );
      break;
    case "key":
      body = (
        <KeyPage providers={providers.providers} connected={connected} onBack={home} onPick={(id) => setPage({ at: "provider", id, method: "api_key", from: page })} />
      );
      break;
    case "custom": {
      const existing = page.at === "custom" ? byId(page.id) : undefined;
      body = (
        <SubPage title={existing === undefined ? "Custom endpoint" : `Edit ${existing.name}`} onBack={home}>
          <CustomEndpointForm
            existing={existing}
            providers={providers.providers}
            remote={remote}
            connected={connected}
            onDone={home}
            onCancel={home}
            onRemoved={home}
          />
        </SubPage>
      );
      break;
    }
    case "provider": {
      const target = page as Extract<Page, { at: "provider" }>;
      body = (
        <ProviderPage
          key={`${target.id}:${target.method ?? "manage"}`}
          provider={byId(target.id)!}
          method={target.method}
          providers={providers}
          remote={remote}
          connected={connected}
          onBack={() => setPage(target.from)}
          onHome={home}
        />
      );
      break;
    }
  }
  return (
    <div ref={top} style={{ scrollMarginBlockStart: "var(--spacing-6)" }}>
      {body}
    </div>
  );
}

function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <VStack gap={4}>
      <HStack gap={2} vAlign="center">
        <IconButton label="Back" icon={<ArrowLeft />} variant="ghost" size="sm" onClick={onBack} />
        <Heading level={3}>{title}</Heading>
      </HStack>
      {children}
    </VStack>
  );
}

function Home({ providers, connected, go }: { providers: readonly ProviderInfo[]; connected: boolean; go: (page: Page) => void }) {
  const linked = providers.filter(isConnected);
  const subscriptions = providers.filter((provider) => provider.oauth?.subscription === true).slice(0, 5);
  const keyed = providers.filter((provider) => provider.apiKey !== undefined && provider.custom === undefined);
  const featured = ["google", "deepseek", "mistral", "groq", "openrouter"]
    .map((id) => keyed.find((provider) => provider.id === id))
    .filter((provider) => provider !== undefined);
  const keyLogos = featured.length > 0 ? featured : keyed.slice(0, 5);
  return (
    <VStack gap={6}>
      {linked.length > 0 ? (
        <List
          density="compact"
          header={
            <Text type="supporting" weight="semibold">
              Connected
            </Text>
          }
        >
            {linked.map((provider) => (
              <ListItem
                key={provider.id}
                label={provider.name}
                description={credentialLine(provider)}
                startContent={<ProviderLogo providerId={provider.id} name={provider.name} baseUrl={provider.custom?.baseUrl} />}
                endContent={chevron}
                onClick={() =>
                  go(provider.custom === undefined ? { at: "provider", id: provider.id, from: HOME } : { at: "custom", id: provider.id })
                }
              />
          ))}
        </List>
      ) : null}
      <VStack gap={2}>
        <Text type="supporting" weight="semibold">
          {linked.length > 0 ? "Add another" : "Connect a model provider"}
        </Text>
        <div className="providers-paths">
          <PathCard
            title="Subscription"
            body="Use a plan you already pay for."
            foot={[...new Set(subscriptions.map((provider) => planOf(provider.oauth!).split(/[\s/]/)[0]))].join(", ")}
            logos={subscriptions.map((provider) => (
              <ProviderLogo key={provider.id} providerId={provider.id} name={provider.name} size={28} />
            ))}
            disabled={!connected}
            onClick={() => go({ at: "subscription" })}
          />
          <PathCard
            title="API key"
            body="Pay per token with a key from the provider."
            foot={`${keyed.length} providers`}
            logos={keyLogos.map((provider) => (
              <ProviderLogo key={provider.id} providerId={provider.id} name={provider.name} size={28} />
            ))}
            disabled={!connected}
            onClick={() => go({ at: "key" })}
          />
          <PathCard
            title="Custom endpoint"
            body="Your own server or gateway."
            foot="Ollama, LM Studio, vLLM, any OpenAI- or Anthropic-compatible URL"
            logos={[
              <ProviderLogo key="ollama" providerId="ollama" name="Ollama" size={28} />,
              <ProviderLogo key="lmstudio" providerId="lmstudio" name="LM Studio" size={28} />,
            ]}
            disabled={!connected}
            onClick={() => go({ at: "custom" })}
          />
        </div>
      </VStack>
    </VStack>
  );
}

function PathCard({
  title,
  body,
  foot,
  logos,
  disabled,
  onClick,
}: {
  title: string;
  body: string;
  foot: string;
  logos: ReactNode[];
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="providers-tile providers-path" onClick={onClick} disabled={disabled}>
      <span className="providers-logo-stack">{logos}</span>
      <span className="providers-path__text">
        <span className="providers-path__title">{title}</span>
        <span className="providers-path__body">{body}</span>
        <span className="providers-tile__sub">{foot}</span>
      </span>
    </button>
  );
}

function Tile({
  provider,
  sub,
  connectedBy,
  disabled,
  onClick,
}: {
  provider: ProviderInfo;
  sub?: string;
  /** Marks the tile when the provider's stored credential is of this kind. */
  connectedBy: LoginMethod;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="providers-tile" onClick={onClick} disabled={disabled}>
      <span className="providers-tile__top">
        <ProviderLogo providerId={provider.id} name={provider.name} size={36} />
        {provider.stored?.kind === connectedBy ? <Token label="Connected" color="green" size="sm" /> : null}
      </span>
      <span className="providers-tile__name">{provider.name}</span>
      {sub === undefined ? null : <span className="providers-tile__sub">{sub}</span>}
    </button>
  );
}

function SubscriptionPage({
  providers,
  connected,
  onBack,
  onPick,
}: {
  providers: readonly ProviderInfo[];
  connected: boolean;
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const withOAuth = providers.filter((provider) => provider.oauth !== undefined);
  // Plans first; account sign-ins (OpenRouter, Radius) bill per token.
  const ordered = [...withOAuth.filter((provider) => provider.oauth!.subscription), ...withOAuth.filter((provider) => !provider.oauth!.subscription)];
  return (
    <SubPage title="Sign in with an account" onBack={onBack}>
      <Text as="p" type="supporting">
        Use a plan you already pay for. Requests count against the plan instead of per-token billing.
      </Text>
      <div className="providers-tiles">
        {ordered.map((provider) => (
          <Tile
            key={provider.id}
            provider={provider}
            sub={provider.oauth!.subscription ? planCaption(provider) : "Account sign-in"}
            connectedBy="oauth"
            disabled={!connected}
            onClick={() => onPick(provider.id)}
          />
        ))}
      </div>
    </SubPage>
  );
}

function KeyPage({
  providers,
  connected,
  onBack,
  onPick,
}: {
  providers: readonly ProviderInfo[];
  connected: boolean;
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const keyed = providers.filter((provider) => provider.apiKey !== undefined && provider.custom === undefined);
  const q = query.trim().toLowerCase();
  const shown = keyed.filter((provider) => q === "" || `${provider.name} ${provider.id}`.toLowerCase().includes(q));
  return (
    <SubPage title="API key" onBack={onBack}>
      <TextInput
        label="Filter providers"
        isLabelHidden
        placeholder={`Filter ${keyed.length} providers`}
        value={query}
        onChange={setQuery}
        hasClear
        width="100%"
      />
      {shown.length === 0 ? (
        <Text as="p" type="supporting">
          {`No provider matches “${query.trim()}”. If it speaks an OpenAI- or Anthropic-compatible API, add it as a custom endpoint.`}
        </Text>
      ) : (
        <div className="providers-tiles">
          {shown.map((provider) => (
            <Tile key={provider.id} provider={provider} connectedBy="api_key" disabled={!connected} onClick={() => onPick(provider.id)} />
          ))}
        </div>
      )}
    </SubPage>
  );
}

const methodLabel = (provider: ProviderInfo, method: LoginMethod): string =>
  method === "api_key" ? "API key" : provider.oauth?.subscription === true ? planCaption(provider) : "Account sign-in";

/**
 * One provider: its connection when it has one, or a login by `method`. A
 * provider keeps one credential, so a login of either kind replaces what
 * is stored; a key saved here overrides an environment variable.
 */
function ProviderPage({
  provider,
  method,
  providers,
  remote,
  connected,
  onBack,
  onHome,
}: {
  provider: ProviderInfo;
  method?: LoginMethod;
  providers: HostProviders;
  remote: RemoteDurable;
  connected: boolean;
  onBack: () => void;
  onHome: () => void;
}) {
  const fallback: LoginMethod = provider.oauth?.subscription === true || provider.apiKey === undefined ? "oauth" : "api_key";
  const [login, setLogin] = useState<LoginMethod | undefined>(method ?? (isConnected(provider) ? undefined : fallback));
  // Back from a login started on this page returns to the provider, not the list.
  const leaveLogin = method === undefined ? () => setLogin(undefined) : onBack;
  return (
    <VStack gap={5}>
      <HStack gap={3} vAlign="center">
        <IconButton label="Back" icon={<ArrowLeft />} variant="ghost" size="sm" onClick={onBack} />
        <ProviderLogo providerId={provider.id} name={provider.name} size={40} />
        <VStack gap={0} style={{ minInlineSize: 0 }}>
          <Heading level={3}>{provider.name}</Heading>
          <Text type="supporting">{login === undefined ? credentialLine(provider) : methodLabel(provider, login)}</Text>
        </VStack>
      </HStack>
      {login === undefined ? (
        <Connection provider={provider} remote={remote} connected={connected} onLogin={setLogin} onRemoved={onHome} />
      ) : (
        <VStack gap={4}>
          <ReplaceNote provider={provider} method={login} />
          <LoginPanel
            key={login}
            providerId={provider.id}
            method={login}
            logins={providers.logins}
            remote={remote}
            connected={connected}
            intro={login === "oauth" ? <Text as="p">{oauthIntro(provider.oauth)}</Text> : undefined}
            signIn={provider.oauth?.loginLabel ?? (provider.oauth === undefined ? undefined : `Sign in with ${planOf(provider.oauth)}`)}
            onDone={onHome}
            onCancel={leaveLogin}
          />
        </VStack>
      )}
    </VStack>
  );
}

const useOAuthLabel = (oauth: OAuth): string =>
  oauth.subscription ? `Use ${planOf(oauth)} instead` : "Sign in to your account instead";

const oauthIntro = (oauth: OAuth | undefined): string =>
  oauth?.subscription === true
    ? `Use your ${planOf(oauth)} plan. Requests count against the plan, not per-token billing.`
    : "Sign in to your account; there's no key to copy.";

function ReplaceNote({ provider, method }: { provider: ProviderInfo; method: LoginMethod }) {
  const stored = provider.stored;
  if (stored === undefined) {
    if (provider.ambient === undefined) return null;
    return (
      <Text as="p" type="supporting">
        {`${provider.ambient} is set in the host's environment. A credential saved here takes precedence over it.`}
      </Text>
    );
  }
  const what = stored.kind === "api_key" ? "the stored API key" : "the stored sign-in";
  return (
    <Text as="p" type="supporting">
      {stored.kind === method ? `Replaces ${what}.` : `Replaces ${what}; a provider keeps one credential.`}
    </Text>
  );
}

/** A connected provider's actions. Ambient auth lives in the host's environment, so it has no log out here. */
function Connection({
  provider,
  remote,
  connected,
  onLogin,
  onRemoved,
}: {
  provider: ProviderInfo;
  remote: RemoteDurable;
  connected: boolean;
  onLogin: (method: LoginMethod) => void;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const stored = provider.stored;
  const oauth = provider.oauth;

  if (stored === undefined) {
    return (
      <VStack gap={3}>
        <Text as="p" type="supporting">
          {`Set as ${provider.ambient ?? "an environment variable"} where the host runs. Remove it there, or save a credential here to override it.`}
        </Text>
        <HStack gap={2} wrap="wrap">
          {provider.apiKey === undefined ? null : (
            <Button label="Save a key here" size="sm" isDisabled={!connected} onClick={() => onLogin("api_key")} />
          )}
          {oauth === undefined ? null : (
            <Button label={useOAuthLabel(oauth)} variant="ghost" size="sm" isDisabled={!connected} onClick={() => onLogin("oauth")} />
          )}
        </HStack>
      </VStack>
    );
  }

  const isKey = stored.kind === "api_key";
  if (confirming) {
    return (
      <VStack gap={2}>
        <Text as="p" type="supporting">
          {isKey
            ? `Removes the key from this host. Conversations using ${provider.name} models stop until you add another.`
            : `Signs this host out of ${provider.name}. Conversations using its models stop until you sign in again.`}
        </Text>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            label={isKey ? "Remove key" : "Log out"}
            variant="destructive"
            size="sm"
            isDisabled={!connected}
            clickAction={() =>
              remote.controller.logout(provider.id).then(onRemoved, (reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
              })
            }
          />
          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
          {error === undefined ? null : <InlineError message={error} />}
        </HStack>
      </VStack>
    );
  }

  const other: LoginMethod = isKey ? "oauth" : "api_key";
  const hasOther = other === "oauth" ? oauth !== undefined : provider.apiKey !== undefined;
  return (
    <VStack gap={3}>
      {provider.ambient === undefined ? null : (
        <Text as="p" type="supporting">
          {`${provider.ambient} is also set where the host runs; the stored credential takes precedence.`}
        </Text>
      )}
      <HStack gap={2} wrap="wrap">
        <Button label={isKey ? "Replace key" : "Sign in again"} size="sm" isDisabled={!connected} onClick={() => onLogin(stored.kind)} />
        <Button label={isKey ? "Remove key…" : "Log out…"} variant="ghost" size="sm" isDisabled={!connected} onClick={() => setConfirming(true)} />
      </HStack>
      {hasOther ? (
        <div>
          <Button
            label={other === "api_key" || oauth === undefined ? "Use an API key instead" : useOAuthLabel(oauth)}
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onClick={() => onLogin(other)}
          />
        </div>
      ) : null}
    </VStack>
  );
}

const storedLoginLine = (login: StoredLogin): string =>
  login.subscription ? "Subscription connected" : login.kind === "api_key" ? "API key configured" : "OAuth connected";

/** A pre-5.21 host's stored login: it can only be logged out from here. */
function StoredLoginCard({ login, connected, remote }: { login: StoredLogin; connected: boolean; remote: RemoteDurable }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card padding={4}>
      <HStack gap={3} vAlign="start">
        <ProviderLogo providerId={login.providerId} name={login.name} />
        <VStack gap={1} style={{ flex: 1, minInlineSize: 0 }}>
          <Heading level={3}>{login.name}</Heading>
          <Text as="p" type="supporting">{storedLoginLine(login)}</Text>
        </VStack>
        {confirming ? null : (
          <MoreMenu
            icon={<MoreHorizontal aria-hidden="true" />}
            label={`${login.name} actions`}
            size="sm"
            variant="ghost"
            isDisabled={!connected}
            items={[{ label: "Log out…", onClick: () => setConfirming(true) }]}
          />
        )}
      </HStack>
      {confirming ? (
        <VStack gap={2} style={{ marginBlockStart: "var(--spacing-4)" }}>
          <Text as="p" type="supporting">{`Removes the stored ${login.name} credential from the host.`}</Text>
          <HStack gap={2} vAlign="center">
            <Button
              label="Log out"
              variant="destructive"
              size="sm"
              isDisabled={!connected}
              onClick={() => void remote.controller.logout(login.providerId)}
            />
            <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
          </HStack>
        </VStack>
      ) : null}
    </Card>
  );
}
