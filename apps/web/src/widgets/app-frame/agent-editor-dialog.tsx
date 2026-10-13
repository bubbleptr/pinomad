// The named-agent editor (ADR-0023 §2): one dialog for create and edit over the
// agents stream — the row appears only once the host pushes the change, never
// from local state.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import type { ModelRef } from "@earendil-works/pi-durable";
import { agentRoleProblem, type AgentRole } from "@pinomad/protocol/agents.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { THINKING_LEVELS } from "@pinomad/protocol/settings.ts";
import type { DurableView, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { summaryOf, thinkingLevelLabels } from "@pinomad/client/model.ts";

const UNPINNED = "";
const modelString = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`;

/** Split `provider/modelId` on the first `/`; undefined for a shape that can't hold both parts. */
const refOf = (raw: string): ModelRef | undefined => {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
};

export function AgentEditorDialog({
  view,
  remote,
  connected,
  role,
  onClose,
}: {
  view: DurableView;
  remote: RemoteDurable;
  connected: boolean;
  /** Present in edit mode — the name can't change (it is the file name). */
  role?: AgentRole;
  onClose: () => void;
}) {
  const editing = role !== undefined;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [model, setModel] = useState(role?.model ?? UNPINNED);
  const [level, setLevel] = useState<ThinkingLevel | typeof UNPINNED>(role?.thinkingLevel ?? UNPINNED);
  const [prompt, setPrompt] = useState(role?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const pinnedSummary = model === UNPINNED ? undefined : summaryOf(view.models, refOf(model));
  const modelOptions = [
    { value: UNPINNED, label: "Don't pin — use the caller's model" },
    ...view.models.map((each) => ({
      value: modelString(each),
      label: `${each.name} (${modelString(each)})`,
    })),
    // A pinned model the host no longer offers stays selectable so saving the
    // role doesn't silently drop the pin.
    ...(model !== UNPINNED && pinnedSummary === undefined ? [{ value: model, label: `${model} (not available)` }] : []),
  ];

  // Levels follow the pinned model when it is a known model; unpinned (or a
  // missing model) falls back to pi-ai's full list.
  const levelValues: readonly ThinkingLevel[] = pinnedSummary === undefined ? THINKING_LEVELS : pinnedSummary.thinkingLevels;
  const levelOptions = [
    { value: UNPINNED, label: "Don't pin" },
    ...levelValues.map((each) => ({ value: each, label: thinkingLevelLabels[each] })),
    // A hand-written or stale pin the model can't take stays visible — leaving
    // it out would show an empty picker while a save silently kept the pin.
    ...(level !== UNPINNED && !levelValues.includes(level)
      ? [{ value: level, label: `${thinkingLevelLabels[level]} (not supported by this model)` }]
      : []),
  ];
  const changeModel = (next: string): void => {
    setModel(next);
    const nextSummary = next === UNPINNED ? undefined : summaryOf(view.models, refOf(next));
    const nextLevels = nextSummary === undefined ? THINKING_LEVELS : nextSummary.thinkingLevels;
    // A pinned level the new model can't take goes back to unpinned rather
    // than saving a pin the role file would report as bogus.
    if (level !== UNPINNED && !nextLevels.includes(level)) setLevel(UNPINNED);
  };

  const save = (): void => {
    const candidate: AgentRole = {
      name: name.trim(),
      description: description.trim(),
      ...(model === UNPINNED ? {} : { model }),
      ...(level === UNPINNED ? {} : { thinkingLevel: level }),
      prompt: prompt.trim(),
    };
    // The host re-checks on write — this just keeps the honest round trip off
    // the wire for the common typo.
    const problem = agentRoleProblem(candidate);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    void (editing ? remote.controller.updateAgent(candidate) : remote.controller.createAgent(candidate)).then(
      () => onClose(),
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="form"
      width={480}
      aria-label={editing ? `Edit ${role.name}` : "New agent"}
    >
      <Layout
        header={
          <DialogHeader
            title={editing ? `Edit ${role.name}` : "New agent"}
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <VStack gap={1}>
                <TextInput
                  label="Name"
                  value={name}
                  onChange={setName}
                  isDisabled={saving || editing}
                  hasAutoFocus={!editing}
                  description={editing ? "The name is the file name and can't be changed." : undefined}
                />
              </VStack>
              <TextInput label="Description" value={description} onChange={setDescription} isDisabled={saving} />
              <Selector
                label="Model"
                value={model}
                options={modelOptions}
                onChange={changeModel}
                isDisabled={saving}
              />
              <Selector
                label="Thinking level"
                value={level}
                options={levelOptions}
                onChange={(next) => setLevel(next as ThinkingLevel | typeof UNPINNED)}
                isDisabled={saving}
              />
              <TextArea label="Prompt" value={prompt} onChange={setPrompt} isDisabled={saving} rows={4} />
              {error === undefined ? null : (
                <Text type="supporting" role="alert" style={{ color: "var(--danger)" }}>
                  {error}
                </Text>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Save"
                variant="primary"
                isDisabled={!connected || saving}
                onClick={save}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
