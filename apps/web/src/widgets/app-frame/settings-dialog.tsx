import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useState, type ReactNode } from "react";
import type { StoredLogin } from "@pinomad/protocol/auth.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { QueueMode } from "@pinomad/protocol/settings.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { ModelSelector } from "../../entities/model/model-selector.tsx";

/**
 * The host's settings (ADR-0021). Everything shown comes from the `settings` /
 * `auth` / `mcp` streams — there is no local state, so a change another device
 * makes appears here the moment the host pushes it.
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
  const connected = view.connection === "connected";
  const settings = view.settings;
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} width={480}>
      <Layout
        header={
          <DialogHeader
            title="Settings"
            subtitle="Shared by every device connected to this host."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={6} padding={2}>
              {settings === null ? (
                <Banner
                  status="warning"
                  title="This host is too old for settings"
                  description="Run `pinomad upgrade` on the host."
                />
              ) : (
                <>
                  <SettingsSection
                    title="New conversations"
                    supporting="Used when a new conversation doesn't pick its own model."
                  >
                    <HStack gap={2} vAlign="center">
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
                          onClick={() =>
                            void remote.controller.updateSettings({ defaultModel: null, defaultThinkingLevel: null })
                          }
                        />
                      ) : null}
                    </HStack>
                  </SettingsSection>
                  <SettingsSection
                    title="While a run is busy"
                    supporting="How queued messages are delivered when the agent reaches the next turn."
                  >
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
                  </SettingsSection>
                </>
              )}
              <SettingsSection title="Logins">
                {view.auth === null ? (
                  <Banner
                    status="warning"
                    title="This host is too old for logins"
                    description="Run `pinomad upgrade` on the host."
                  />
                ) : view.auth.logins.length === 0 ? (
                  <Text type="supporting">No stored logins. Log in with the Pi CLI on the host.</Text>
                ) : (
                  <List density="compact">
                    {view.auth.logins.map((login) => (
                      <LoginRow key={login.providerId} login={login} connected={connected} remote={remote} />
                    ))}
                  </List>
                )}
              </SettingsSection>
              <SettingsSection title="MCP">
                {view.mcp === null ? (
                  <Text type="supporting">Loading…</Text>
                ) : (
                  <>
                    <Text type="supporting" style={{ userSelect: "all" }}>
                      {view.mcp.configPath}
                    </Text>
                    {view.mcp.servers.length === 0 ? (
                      <Text type="supporting">No servers configured.</Text>
                    ) : (
                      <List density="compact">
                        {view.mcp.servers.map((server) => (
                          <ListItem key={server.name} label={server.name} description={server.state} />
                        ))}
                      </List>
                    )}
                  </>
                )}
              </SettingsSection>
              <SettingsSection title="Host">
                <List density="compact">
                  <ListItem
                    label="Data directory"
                    description={
                      <span style={{ wordBreak: "break-all", userSelect: "all" }}>{view.session.directory}</span>
                    }
                  />
                  <ListItem
                    label="Settings file"
                    description={
                      <span style={{ wordBreak: "break-all", userSelect: "all" }}>
                        {view.session.directory}/settings.json
                      </span>
                    }
                  />
                </List>
                <Text type="supporting">Edit this file by hand only while the host is stopped.</Text>
              </SettingsSection>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function SettingsSection({
  title,
  supporting,
  children,
}: {
  title: string;
  supporting?: string;
  children: ReactNode;
}) {
  return (
    <VStack gap={2}>
      <VStack gap={0.5}>
        <Text type="label" weight="semibold">
          {title}
        </Text>
        {supporting === undefined ? null : <Text type="supporting">{supporting}</Text>}
      </VStack>
      {children}
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

const loginKindLabel = (login: StoredLogin): string =>
  login.subscription ? "Subscription" : login.kind === "api_key" ? "API key" : "OAuth";

/** Two clicks to sign out: the first arms the row, the second really logs out — pi's CLI session goes with it. */
function LoginRow({
  login,
  connected,
  remote,
}: {
  login: StoredLogin;
  connected: boolean;
  remote: RemoteDurable;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <ListItem
        label={login.name}
        description={`This also signs the Pi CLI on the host out of ${login.name}.`}
        endContent={
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
        }
      />
    );
  }
  return (
    <ListItem
      label={login.name}
      endContent={
        <HStack gap={2} vAlign="center">
          <Token label={loginKindLabel(login)} size="sm" />
          <Button
            label="Log out"
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onClick={() => setConfirming(true)}
          />
        </HStack>
      }
    />
  );
}
