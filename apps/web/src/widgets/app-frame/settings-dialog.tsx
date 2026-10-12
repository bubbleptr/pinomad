import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useState, type ReactNode } from "react";
import type { StoredLogin } from "@pinomad/protocol/auth.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { QueueMode } from "@pinomad/protocol/settings.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";
import { ArrowLeft, ChatBubble, ChevronRight, Info, Key, MoreHorizontal, Puzzle, Sparkles } from "../../shared/ui/icons.tsx";

const SECTIONS = [
  { id: "providers", title: "Providers", icon: Key },
  { id: "models", title: "Models", icon: Sparkles },
  { id: "mcp", title: "MCP", icon: Puzzle },
  { id: "chats", title: "Chats", icon: ChatBubble },
  { id: "about", title: "About", icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const sectionTitle = (id: SectionId): string => SECTIONS.find((section) => section.id === id)!.title;

const sectionIcon = (Icon: (typeof SECTIONS)[number]["icon"]): ReactNode => (
  <Icon aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
);

/**
 * The host's settings and stored logins (ADR-0021): a left section nav on wide
 * screens, an iOS-style drill-in under 640px. Everything shown comes from the
 * `settings` / `auth` / `mcp` streams — the open section is the only local
 * state, so a change another device makes appears here the moment the host
 * pushes it.
 */
export function SettingsDialog({
  view,
  remote,
  onClose,
}: {
  view: DurableView;
  remote: RemoteDurable;
  onClose: () => void;
}) {
  const compact = useMediaQuery("(max-width: 640px)");
  const [section, setSection] = useState<SectionId | undefined>(undefined);
  const connected = view.connection === "connected";
  const active = section ?? "providers";

  const sectionNav = (
    <LayoutPanel padding={2} width="calc(var(--spacing-10) * 7)" hasDivider>
      <SideNav aria-label="Settings sections" style={{ width: "100%" }}>
        <VStack gap={1}>
          {SECTIONS.map((entry) => (
            <SideNavItem
              key={entry.id}
              label={entry.title}
              icon={sectionIcon(entry.icon)}
              isSelected={entry.id === active}
              onClick={() => setSection(entry.id)}
            />
          ))}
        </VStack>
      </SideNav>
    </LayoutPanel>
  );

  const sectionList = (
    <List density="compact">
      {SECTIONS.map((entry) => (
        <ListItem
          key={entry.id}
          label={entry.title}
          startContent={sectionIcon(entry.icon)}
          endContent={
            <ChevronRight aria-hidden="true" style={{ width: "var(--spacing-4)", height: "var(--spacing-4)" }} />
          }
          onClick={() => setSection(entry.id)}
        />
      ))}
    </List>
  );

  return (
    <Dialog
      aria-label="Settings"
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="form"
      width="calc(var(--spacing-10) * 22)"
      maxHeight="90dvh"
      variant={compact ? "fullscreen" : "standard"}
      padding={4}
    >
      <Layout
        padding={4}
        style={{ height: compact ? "100dvh" : "min(85dvh, calc(var(--spacing-10) * 17))" }}
        header={
          <DialogHeader
            title={compact && section !== undefined ? sectionTitle(section) : "Settings"}
            startContent={
              compact && section !== undefined ? (
                <IconButton
                  label="Back"
                  icon={<ArrowLeft />}
                  variant="ghost"
                  // DialogHeader pulls its end slot (the close X) up by spacing-2
                  // to center on the title; the start slot needs the same lift.
                  style={{ marginBlock: "calc(-1 * var(--spacing-2))" }}
                  onClick={() => setSection(undefined)}
                />
              ) : undefined
            }
            onOpenChange={() => onClose()}
            hasDivider
          />
        }
        start={compact ? undefined : sectionNav}
        content={
          <LayoutContent padding={compact ? 4 : 6}>
            {compact && section === undefined ? (
              sectionList
            ) : (
              <SectionPage view={view} remote={remote} connected={connected} section={active} showTitle={!compact} />
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function SectionPage({
  view,
  remote,
  connected,
  section,
  showTitle,
}: {
  view: DurableView;
  remote: RemoteDurable;
  connected: boolean;
  section: SectionId;
  showTitle: boolean;
}) {
  const { title, supporting, body } = sectionBody(view, remote, connected, section);
  const headingId = `settings-${section}-heading`;
  return (
    <VStack
      as="section"
      {...(showTitle ? { "aria-labelledby": headingId } : { "aria-label": title })}
      gap={3}
    >
      <VStack gap={2}>
        {showTitle ? <Heading level={2} id={headingId}>{title}</Heading> : null}
        {supporting}
      </VStack>
      {body}
    </VStack>
  );
}

function sectionBody(
  view: DurableView,
  remote: RemoteDurable,
  connected: boolean,
  section: SectionId,
): { title: string; supporting?: ReactNode; body: ReactNode } {
  switch (section) {
    case "providers":
      return {
        title: "Providers",
        supporting: (
          <Text as="p" type="supporting">
            Logins are stored on the host in Pi's <code>auth.json</code>. Log in with the Pi CLI on the
            host — logging out here signs the Pi CLI out too. Every device connected to this host sees
            the same logins.
          </Text>
        ),
        body: <ProvidersSection view={view} remote={remote} connected={connected} />,
      };
    case "models":
      return {
        title: "Models",
        supporting: <Text as="p" type="supporting">Used when a new conversation doesn't pick its own model.</Text>,
        body: <ModelsSection view={view} remote={remote} connected={connected} />,
      };
    case "mcp":
      return { title: "MCP", body: <McpSection view={view} /> };
    case "chats":
      return {
        title: "Chats",
        supporting: (
          <Text as="p" type="supporting">
            How queued messages are delivered when the agent reaches the next turn.
          </Text>
        ),
        body: <ChatsSection view={view} remote={remote} connected={connected} />,
      };
    case "about":
      return { title: "About", body: <AboutSection view={view} /> };
  }
}

function ProvidersSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const auth = view.auth;
  if (auth === null) {
    return <Banner status="warning" title="This host is too old for logins" description="Run `pinomad upgrade` on the host." />;
  }
  const logins = auth.logins;
  return (
    <VStack gap={3}>
      {logins.length === 0 ? (
        <Text as="p" type="supporting">No stored logins. Log in with the Pi CLI on the host.</Text>
      ) : (
        <>
          <Text as="p" type="supporting">{`${logins.length} provider${logins.length === 1 ? "" : "s"} logged in`}</Text>
          {logins.map((login) => (
            <LoginCard key={login.providerId} login={login} connected={connected} remote={remote} />
          ))}
        </>
      )}
    </VStack>
  );
}

function ModelsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return <Banner status="warning" title="This host is too old for settings" description="Run `pinomad upgrade` on the host." />;
  }
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <ModelSelector
        models={view.models}
        selected={{
          model: settings.defaultModel ?? undefined,
          level: settings.defaultThinkingLevel ?? "off",
        }}
        isDisabled={!connected}
        onModelChange={(model) => void remote.controller.updateSettings({ defaultModel: model })}
        onLevelChange={(level) => void remote.controller.updateSettings({ defaultThinkingLevel: level })}
      />
      {settings.custom.includes("defaultModel") || settings.custom.includes("defaultThinkingLevel") ? (
        <Button
          label="Use pi's defaults"
          variant="ghost"
          size="sm"
          isDisabled={!connected}
          onClick={() => void remote.controller.updateSettings({ defaultModel: null, defaultThinkingLevel: null })}
        />
      ) : null}
    </HStack>
  );
}

function ChatsSection({ view, remote, connected }: { view: DurableView; remote: RemoteDurable; connected: boolean }) {
  const settings = view.settings;
  if (settings === null) {
    return <Banner status="warning" title="This host is too old for settings" description="Run `pinomad upgrade` on the host." />;
  }
  return (
    <VStack gap={4}>
      <ModeSetting
        title="Steer messages"
        value={settings.steeringMode}
        customized={settings.custom.includes("steeringMode")}
        disabled={!connected}
        onChange={(mode) => void remote.controller.updateSettings({ steeringMode: mode })}
        onReset={() => void remote.controller.updateSettings({ steeringMode: null })}
      />
      <ModeSetting
        title="Follow-up messages"
        value={settings.followUpMode}
        customized={settings.custom.includes("followUpMode")}
        disabled={!connected}
        onChange={(mode) => void remote.controller.updateSettings({ followUpMode: mode })}
        onReset={() => void remote.controller.updateSettings({ followUpMode: null })}
      />
    </VStack>
  );
}

function McpSection({ view }: { view: DurableView }) {
  const mcp = view.mcp;
  if (mcp === null) return <Text as="p" type="supporting">Loading…</Text>;
  return (
    <VStack gap={3}>
      <Text as="p" type="supporting" style={{ userSelect: "all" }}>
        {mcp.configPath}
      </Text>
      {mcp.servers.length === 0 ? (
        <Text as="p" type="supporting">No servers configured.</Text>
      ) : (
        <List density="compact">
          {mcp.servers.map((server) => (
            <ListItem
              key={server.name}
              label={server.name}
              endContent={<Token label={server.state} size="sm" />}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

function AboutSection({ view }: { view: DurableView }) {
  const host = view.host;
  return (
    <VStack gap={3}>
      <List density="compact">
        <ListItem label="Host version" description={host?.version ?? "Source checkout"} />
        <ListItem
          label="Protocol"
          description={host === undefined ? "—" : `${host.protocol.major}.${host.protocol.minor}`}
        />
        <ListItem
          label="Data directory"
          description={<span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}</span>}
        />
        <ListItem
          label="Settings file"
          description={
            <span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}/settings.json</span>
          }
        />
      </List>
      <Text as="p" type="supporting">Edit the settings file by hand only while the host is stopped.</Text>
    </VStack>
  );
}

function ModeSetting({
  title,
  value,
  customized,
  disabled,
  onChange,
  onReset,
}: {
  title: string;
  value: QueueMode;
  customized: boolean;
  disabled: boolean;
  onChange: (mode: QueueMode) => void;
  onReset: () => void;
}) {
  return (
    <VStack gap={1}>
      <Text>{title}</Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <SegmentedControl
          className="shrink-0"
          value={value}
          onChange={(next) => onChange(next as QueueMode)}
          label={title}
          size="sm"
          isDisabled={disabled}
        >
          <SegmentedControlItem value="one-at-a-time" label="One at a time" />
          <SegmentedControlItem value="all" label="All at once" />
        </SegmentedControl>
        {customized ? (
          <Button label="Use pi's default" variant="ghost" size="sm" isDisabled={disabled} onClick={onReset} />
        ) : null}
      </HStack>
    </VStack>
  );
}

const loginStatusLine = (login: StoredLogin): string =>
  login.subscription ? "Subscription connected" : login.kind === "api_key" ? "API key configured" : "OAuth connected";

/**
 * The "…" menu arms an inline confirmation inside the card: signing out here
 * also ends the Pi CLI's session on the host, so it needs a second step.
 */
function LoginCard({
  login,
  connected,
  remote,
}: {
  login: StoredLogin;
  connected: boolean;
  remote: RemoteDurable;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card padding={4}>
      <HStack gap={3} vAlign="start">
        <VStack gap={1} style={{ flex: 1, minInlineSize: 0 }}>
          <Heading level={3}>{login.name}</Heading>
          <Text as="p" type="supporting">{loginStatusLine(login)}</Text>
        </VStack>
        {confirming ? null : (
          <HStack gap={1} vAlign="center">
            <MoreMenu
              icon={<MoreHorizontal aria-hidden="true" />}
              label={`${login.name} actions`}
              size="sm"
              variant="ghost"
              isDisabled={!connected}
              items={[{ label: "Log out…", onClick: () => setConfirming(true) }]}
            />
          </HStack>
        )}
      </HStack>
      {confirming ? (
        <VStack gap={2} style={{ marginBlockStart: "var(--spacing-4)" }}>
          <Text as="p" type="supporting">{`This also signs the Pi CLI on the host out of ${login.name}.`}</Text>
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
