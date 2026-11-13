// The named-agent editor (ADR-0023 §2): one dialog for create and edit over the
// agents stream — the row appears only once the host pushes the change, never
// from local state.
import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.tsx";
import { Field, FieldDescription, FieldError, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { Textarea } from "../../shared/ui/textarea.tsx";
import { useState } from "react";
import type { ModelRef } from "@earendil-works/pi-durable";
import { agentNameProblem, agentRoleProblem, type AgentRole } from "@pinomad/protocol/agents.ts";
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

/**
 * A new agent's name that is already a file on the host: a loaded role, or a
 * `.md` it couldn't load. The host refuses it too, but only as a plain message.
 */
function takenProblem(view: DurableView, name: string): string | undefined {
  const agents = view.agents;
  if (agents === null || agents === undefined) return undefined;
  const taken =
    agents.roles.some((role) => role.name === name) || agents.problems.some((problem) => problem.file === `${name}.md`);
  return taken ? `An agent named "${name}" already exists` : undefined;
}

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
  const [nameError, setNameError] = useState<string>();
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
    // the wire for the common typo. A bad name belongs to the Name field.
    const badName = agentNameProblem(candidate.name) ?? (editing ? undefined : takenProblem(view, candidate.name));
    const problem = badName === undefined ? agentRoleProblem(candidate) : undefined;
    setNameError(badName);
    setError(problem);
    if (badName !== undefined || problem !== undefined) return;
    setSaving(true);
    void (editing ? remote.controller.updateAgent(candidate) : remote.controller.createAgent(candidate)).then(
      () => onClose(),
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${role.name}` : "New agent"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Field disabled={saving || editing} invalid={nameError !== undefined}>
                <FieldLabel>Name</FieldLabel>
                <FieldDescription>{editing ? "The name is the file name and can't be changed." : undefined}</FieldDescription>
                <Input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameError(undefined);
                  }}
                  autoFocus={!editing}
                  data-autofocus={!editing || undefined}
                />
                <FieldError>{nameError}</FieldError>
              </Field>
            </div>
            <Field disabled={saving}>
              <FieldLabel>Description</FieldLabel>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field disabled={saving}>
              <FieldLabel>Model</FieldLabel>
              <Select
                items={modelOptions}
                value={model}
                onValueChange={(next: string | null) => {
                  if (next !== null) changeModel(next);
                }}
              >
                {/* UNPINNED is "", which Base UI styles as a placeholder; here it is a real choice. */}
                <SelectTrigger className="w-full data-placeholder:text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field disabled={saving}>
              <FieldLabel>Thinking level</FieldLabel>
              <Select
                items={levelOptions}
                value={level}
                onValueChange={(next: string | null) => {
                  if (next !== null) setLevel(next as ThinkingLevel | typeof UNPINNED);
                }}
              >
                <SelectTrigger className="w-full data-placeholder:text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {levelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field disabled={saving}>
              <FieldLabel>Prompt</FieldLabel>
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
              />
            </Field>
            <FormError>{error}</FormError>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!connected || saving}
            onClick={save}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
