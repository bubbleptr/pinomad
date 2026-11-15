// The Tasks surface's event sources (ADR-0051 §10): where an Inbox's events
// come from besides the user and the agent. Each can be switched off or
// removed; a webhook's secret shows once, when it is made or reset.
import { useEffect, useId, useState, type FormEvent } from "react";
import type { PluginInfo, PluginSourceInfo } from "@pinomad/protocol/frames.ts";
import {
  INBOX_SOURCE_FILTER_MAX,
  INBOX_SOURCE_NAME_MAX,
  INBOX_SOURCE_NOTE_MAX,
  type InboxSchedule,
  type InboxSource,
  type InboxSourceSpec,
  type InboxWebhookAccess,
  type ProjectInbox,
} from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../shared/ui/alert-dialog.tsx";
import { Button } from "../../shared/ui/button.tsx";
import { CodeBlock } from "../../shared/ui/code-block/code-block.tsx";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../shared/ui/dropdown-menu.tsx";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { Box, Clock, Globe, MoreHorizontal } from "../../shared/ui/icons.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { RadioGroup, RadioGroupItem } from "../../shared/ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "../../shared/ui/segmented-control.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.tsx";
import { Switch } from "../../shared/ui/switch.tsx";
import { Textarea } from "../../shared/ui/textarea.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";
import { messageTime } from "../chat/chat-time.ts";

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function scheduleText(schedule: InboxSchedule): string {
  const when =
    schedule.kind === "daily"
      ? `Every day ${schedule.time}`
      : schedule.kind === "weekdays"
        ? `Weekdays ${schedule.time}`
        : schedule.kind === "weekly"
          ? `Every ${DAYS[schedule.day] ?? "week"} ${schedule.time}`
          : `Cron ${schedule.expression}`;
  // The zone only when it isn't this device's: most schedules are made where they're read.
  return schedule.timeZone === localZone() ? when : `${when} ${schedule.timeZone}`;
}

const trustText = (trusted: boolean): string => (trusted ? "All tools" : "Restricted tools");

const pluginSource = (plugins: readonly PluginInfo[], plugin: string, source: string): PluginSourceInfo | undefined =>
  plugins.find((each) => each.name === plugin)?.sources?.find((each) => each.name === source);

function sourceDescription(source: InboxSource, plugins: readonly PluginInfo[]): string {
  const { spec } = source;
  switch (spec.kind) {
    case "schedule": {
      const next = source.next === undefined ? undefined : messageTime(source.next)?.label;
      return next === undefined ? scheduleText(spec.schedule) : `${scheduleText(spec.schedule)} · next ${next}`;
    }
    case "plugin":
      return [
        pluginSource(plugins, spec.plugin, spec.source)?.description ?? spec.source,
        spec.plugin,
        ...(spec.filter === "" ? [] : [spec.filter]),
        trustText(source.trusted),
      ].join(" · ");
    case "webhook":
      return `Webhook · ${trustText(source.trusted)}`;
  }
}

function SourceIcon({ kind }: { kind: InboxSourceSpec["kind"] }) {
  const Icon = kind === "schedule" ? Clock : kind === "plugin" ? Box : Globe;
  return <Icon aria-hidden="true" className="size-4 text-muted-foreground" />;
}

/** What the user asked of one row: the confirm for a removal or a secret reset, or the new secret. */
type RowDialog =
  | { kind: "remove"; source: InboxSource }
  | { kind: "reset"; source: InboxSource }
  | { kind: "access"; title: string; access: InboxWebhookAccess };

export function SourcesSection({
  inbox,
  remote,
  connected,
  plugins,
  externalSources,
}: {
  inbox: ProjectInbox;
  remote: RemoteDurable;
  connected: boolean;
  plugins: readonly PluginInfo[];
  externalSources: boolean;
}) {
  const heading = useId();
  const error = useErrorToast();
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<RowDialog>();
  // A flip asked for, by source: the switch shows it until the view leaves
  // the value it was flipped from, then follows the view again.
  const [flips, setFlips] = useState<ReadonlyMap<string, { from: boolean; pending: boolean }>>(new Map());
  useEffect(() => {
    const caughtUp = [...flips].filter(([id, flip]) => inbox.sources?.find((each) => each.id === id)?.enabled !== flip.from);
    if (caughtUp.length === 0) return;
    setFlips((prev) => {
      const next = new Map(prev);
      for (const [id] of caughtUp) next.delete(id);
      return next;
    });
  }, [flips, inbox.sources]);
  // Before 5.39 the host has no sources and refuses the calls.
  if (inbox.sources === undefined) return null;
  const sources = inbox.sources;

  const updateFlip = (id: string, update: (flip: { from: boolean; pending: boolean }) => { from: boolean; pending: boolean } | undefined): void =>
    setFlips((prev) => {
      const flip = prev.get(id);
      if (flip === undefined) return prev;
      const next = new Map(prev);
      const updated = update(flip);
      if (updated === undefined) next.delete(id);
      else next.set(id, updated);
      return next;
    });
  const toggle = (source: InboxSource, enabled: boolean): void => {
    error.clear();
    setFlips((prev) => new Map(prev).set(source.id, { from: source.enabled, pending: true }));
    remote.controller.setInboxSourceEnabled(source.id, enabled).then(
      // The view may have caught up already, which dropped the flip.
      () => updateFlip(source.id, (flip) => ({ ...flip, pending: false })),
      (reason: unknown) => {
        updateFlip(source.id, () => undefined);
        error.show(`Couldn't turn “${source.name}” ${enabled ? "on" : "off"}: ${messageOf(reason)}`);
      },
    );
  };

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1 border-t border-border px-3 pt-3 pb-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={heading} className="text-xs/5 font-medium text-muted-foreground">
          Event sources
        </h3>
        <Button className="ms-auto" variant="secondary" size="sm" disabled={!connected} onClick={() => setAdding(true)}>
          Add source
        </Button>
      </div>
      {sources.length === 0 ? (
        <p className="text-sm/5 text-muted-foreground">None yet. A schedule, a plugin or a webhook can open tasks here.</p>
      ) : (
        <ItemGroup aria-labelledby={heading} className="-mx-3">
          {sources.map((source) => {
            const flip = flips.get(source.id);
            const flipped = flip !== undefined && flip.from === source.enabled;
            return (
              <Item key={source.id} size="sm" render={<li />}>
                <ItemMedia>
                  <SourceIcon kind={source.spec.kind} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{source.name}</ItemTitle>
                  <ItemDescription className="whitespace-normal">{sourceDescription(source, plugins)}</ItemDescription>
                  {source.problem === undefined ? null : <ItemDescription className="whitespace-normal text-destructive">{source.problem}</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={source.name}
                    size="sm"
                    checked={flipped ? !source.enabled : source.enabled}
                    disabled={!connected || (flipped && flip.pending)}
                    onCheckedChange={(checked) => toggle(source, checked)}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={!connected}
                      render={
                        <IconButton
                          icon={<MoreHorizontal aria-hidden="true" />}
                          label={`More for ${source.name}`}
                          tooltip={`More for ${source.name}`}
                          size="sm"
                          variant="ghost"
                        />
                      }
                    />
                    <DropdownMenuContent>
                      {source.spec.kind === "webhook" ? (
                        <DropdownMenuItem onClick={() => setDialog({ kind: "reset", source })}>Reset secret</DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onClick={() => setDialog({ kind: "remove", source })}>Remove</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {adding ? (
        <AddSourceDialog
          project={inbox.project}
          remote={remote}
          connected={connected}
          plugins={plugins}
          externalSources={externalSources}
          onClose={(added) => {
            setAdding(false);
            if (added !== undefined) setDialog({ kind: "access", title: "Webhook added", access: added });
          }}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <ConfirmSource
          title={`Remove ${dialog.source.name}?`}
          description="Tasks it already opened stay."
          action="Remove"
          run={async () => {
            await remote.controller.removeInboxSource(dialog.source.id);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        />
      ) : dialog?.kind === "reset" ? (
        <ConfirmSource
          title={`Reset the secret of ${dialog.source.name}?`}
          description="The old secret stops working at once; senders need the new one."
          action="Reset secret"
          run={async () => {
            const access = await remote.controller.resetInboxWebhookSecret(dialog.source.id);
            setDialog({ kind: "access", title: `New secret for ${dialog.source.name}`, access });
          }}
          onClose={() => setDialog(undefined)}
        />
      ) : dialog?.kind === "access" ? (
        <WebhookAccessDialog title={dialog.title} access={dialog.access} remote={remote} connected={connected} onClose={() => setDialog(undefined)} />
      ) : null}
    </section>
  );
}

/** A destructive step on one source, confirmed; the host's refusal stays in the dialog. */
function ConfirmSource({
  title,
  description,
  action,
  run,
  onClose,
}: {
  title: string;
  description: string;
  action: string;
  /** Does the step and moves on, closing or replacing this dialog; a rejection stays here. */
  run: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <FormError>{error}</FormError>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              run().catch((reason: unknown) => {
                setBusy(false);
                setError(messageOf(reason));
              });
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A webhook's URL, source id and secret, shown this once. Mounted only while open, so closing forgets the secret. */
export function WebhookAccessDialog({
  title,
  access: initial,
  remote,
  connected,
  onClose,
}: {
  title: string;
  access: InboxWebhookAccess;
  remote: RemoteDurable;
  connected: boolean;
  onClose: () => void;
}) {
  const [access, setAccess] = useState(initial);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string>();
  const reset = (): void => {
    setResetting(true);
    setError(undefined);
    remote.controller.resetInboxWebhookSecret(access.source).then(
      (fresh) => {
        setResetting(false);
        setAccess(fresh);
      },
      (reason: unknown) => {
        setResetting(false);
        setError(messageOf(reason));
      },
    );
  };
  const value = (label: string, description: string | undefined, code: string) => (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{label}</p>
      {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
      {/* Room for the copy button, which floats over a block without a header. */}
      <CodeBlock className="[&_code]:pe-10" code={code} hasCopyButton isWrapped width="100%" />
    </div>
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Copy the secret now: it isn't shown again. Reset it if it's lost.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {value("URL", "From another machine on your tailnet, put the host's MagicDNS name in place of the address.", access.url)}
          {value("Source", "Sent as the X-Pinomad-Source header.", access.source)}
          {value("Secret", "Signs each request: X-Pinomad-Signature is the HMAC-SHA256 of “<timestamp>.<body>”.", access.secret)}
          <FormError>{error}</FormError>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" loading={resetting} disabled={!connected} onClick={reset}>
            Reset secret
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Kind = InboxSourceSpec["kind"];
type Repeat = InboxSchedule["kind"];

const REPEATS: Record<Repeat, string> = { daily: "Every day", weekdays: "Weekdays", weekly: "Every week", cron: "Cron" };
const DAY_ITEMS: Record<string, string> = Object.fromEntries(DAYS.map((day, index) => [String(index), day]));
const NAME_PLACEHOLDER: Record<Kind, string> = { schedule: "Dependency check", plugin: "Bugs on acme/web", webhook: "NAS backups" };

const isTime = (text: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(text);

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone !== "";
  } catch {
    return false;
  }
}

/**
 * The add dialog: a schedule, a plugin's source or a webhook, and for the
 * last two how far their tasks are trusted. Checks what it can cheaply (empty
 * fields, lengths, a time, a cron's five fields); the host checks the rest and
 * its refusal shows above the buttons. `onClose` gets a new webhook's access.
 */
export function AddSourceDialog({
  project,
  remote,
  connected,
  plugins,
  externalSources,
  onClose,
}: {
  project: string;
  remote: RemoteDurable;
  connected: boolean;
  plugins: readonly PluginInfo[];
  externalSources: boolean;
  onClose: (webhook?: InboxWebhookAccess) => void;
}) {
  const withSources = plugins.filter((plugin) => (plugin.sources?.length ?? 0) > 0);
  const [kind, setKind] = useState<Kind>("schedule");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState("1");
  const [cron, setCron] = useState("");
  const [zone, setZone] = useState(localZone);
  const [plugin, setPlugin] = useState(withSources[0]?.name ?? "");
  const [event, setEvent] = useState(withSources[0]?.sources?.[0]?.name ?? "");
  const [filter, setFilter] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const trustId = useId();

  const pickedPlugin = withSources.find((each) => each.name === plugin);
  const picked = pickedPlugin?.sources?.find((each) => each.name === event);

  const problems = {
    name:
      name.trim() === ""
        ? "Give it a name"
        : name.trim().length > INBOX_SOURCE_NAME_MAX
          ? `At most ${INBOX_SOURCE_NAME_MAX} characters`
          : undefined,
    note:
      kind !== "schedule"
        ? undefined
        : note.trim() === ""
          ? "Say what each task should do"
          : note.trim().length > INBOX_SOURCE_NOTE_MAX
            ? `At most ${INBOX_SOURCE_NOTE_MAX} characters`
            : undefined,
    time: kind === "schedule" && repeat !== "cron" && !isTime(time) ? "A 24-hour time, such as 08:30" : undefined,
    cron:
      kind === "schedule" && repeat === "cron" && cron.trim().split(/\s+/).filter(Boolean).length !== 5
        ? "Five fields: minute hour day-of-month month day-of-week"
        : undefined,
    zone: kind === "schedule" && !isZone(zone.trim()) ? "An IANA time zone, such as Europe/Berlin" : undefined,
    filter: kind === "plugin" && filter.trim().length > INBOX_SOURCE_FILTER_MAX ? `At most ${INBOX_SOURCE_FILTER_MAX} characters` : undefined,
  };
  const shown = (problem: string | undefined): string | undefined => (tried ? problem : undefined);

  const spec = (): InboxSourceSpec => {
    switch (kind) {
      case "schedule": {
        const timeZone = zone.trim();
        const schedule: InboxSchedule =
          repeat === "cron"
            ? { kind: "cron", expression: cron.trim().split(/\s+/).join(" "), timeZone }
            : repeat === "weekly"
              ? { kind: "weekly", day: Number(day), time, timeZone }
              : { kind: repeat, time, timeZone };
        return { kind: "schedule", schedule, note: note.trim() };
      }
      case "plugin":
        return { kind: "plugin", plugin, source: event, filter: picked?.filter === undefined ? "" : filter.trim() };
      case "webhook":
        return { kind: "webhook" };
    }
  };

  const submit = (submitted: FormEvent): void => {
    submitted.preventDefault();
    setTried(true);
    if (saving || Object.values(problems).some((problem) => problem !== undefined)) return;
    if (kind === "plugin" && picked === undefined) return;
    setSaving(true);
    setError(undefined);
    // A schedule's note is the user's own words, so its tasks count as theirs.
    remote.controller.addInboxSource(project, name.trim(), kind === "schedule" ? true : trusted, spec()).then(
      (added) => onClose(added.webhook),
      (reason: unknown) => {
        setSaving(false);
        setError(messageOf(reason));
      },
    );
  };

  const projectName = project.split("/").filter(Boolean).pop() ?? project;
  const nothingToPick = kind === "plugin" && withSources.length === 0;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>Add an event source</DialogTitle>
          <DialogDescription>Its events open tasks in {projectName}'s Inbox.</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} autoComplete="off" noValidate>
          <DialogBody className="flex flex-col gap-4">
            {externalSources ? (
              <SegmentedControl
                aria-label="Kind"
                className="w-full"
                value={kind}
                onValueChange={(value) => {
                  setKind(value as Kind);
                  setError(undefined);
                }}
              >
                <SegmentedControlItem className="flex-1" value="schedule">Schedule</SegmentedControlItem>
                <SegmentedControlItem className="flex-1" value="plugin">Plugin</SegmentedControlItem>
                <SegmentedControlItem className="flex-1" value="webhook">Webhook</SegmentedControlItem>
              </SegmentedControl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Plugin and webhook sources need a sandbox for Inbox runs, which this host doesn't have, so it takes schedules only.
              </p>
            )}

            <Field disabled={saving} invalid={shown(problems.name) !== undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input value={name} onChange={(change) => setName(change.target.value)} placeholder={NAME_PLACEHOLDER[kind]} data-autofocus />
              <FieldError>{shown(problems.name)}</FieldError>
            </Field>

            {kind === "schedule" ? (
              <>
                <div className="flex flex-wrap gap-3">
                  <Field disabled={saving} className="min-w-36 flex-1">
                    <FieldLabel>Repeat</FieldLabel>
                    <Select
                      items={REPEATS}
                      value={repeat}
                      onValueChange={(value: string | null) => {
                        if (value !== null) setRepeat(value as Repeat);
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Repeat">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(Object.keys(REPEATS) as Repeat[]).map((value) => (
                            <SelectItem key={value} value={value}>
                              {REPEATS[value]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  {repeat === "weekly" ? (
                    <Field disabled={saving} className="min-w-36 flex-1">
                      <FieldLabel>Day</FieldLabel>
                      <Select
                        items={DAY_ITEMS}
                        value={day}
                        onValueChange={(value: string | null) => {
                          if (value !== null) setDay(value);
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Day">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {DAYS.map((label, index) => (
                              <SelectItem key={label} value={String(index)}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {repeat === "cron" ? null : (
                    <Field disabled={saving} invalid={shown(problems.time) !== undefined} className="w-28 shrink-0">
                      <FieldLabel>Time</FieldLabel>
                      <Input type="time" value={time} onChange={(change) => setTime(change.target.value)} />
                      <FieldError>{shown(problems.time)}</FieldError>
                    </Field>
                  )}
                </div>
                {repeat === "cron" ? (
                  <Field disabled={saving} invalid={shown(problems.cron) !== undefined}>
                    <FieldLabel>Cron expression</FieldLabel>
                    <Input className="font-mono" value={cron} onChange={(change) => setCron(change.target.value)} placeholder="0 9 * * 1-5" />
                    <FieldError>{shown(problems.cron)}</FieldError>
                  </Field>
                ) : null}
                <Field disabled={saving} invalid={shown(problems.zone) !== undefined}>
                  <FieldLabel>Time zone</FieldLabel>
                  <Input value={zone} onChange={(change) => setZone(change.target.value)} />
                  <FieldError>{shown(problems.zone)}</FieldError>
                </Field>
                <Field disabled={saving} invalid={shown(problems.note) !== undefined}>
                  <FieldLabel>Task</FieldLabel>
                  <FieldDescription>Each time it fires, this opens a task named after the source.</FieldDescription>
                  <Textarea rows={3} value={note} onChange={(change) => setNote(change.target.value)} placeholder="Look for outdated dependencies and open a task for each one worth upgrading." />
                  <FieldError>{shown(problems.note)}</FieldError>
                </Field>
              </>
            ) : null}

            {kind === "plugin" ? (
              nothingToPick ? (
                <p className="text-sm text-muted-foreground">No loaded plugin offers event sources. Install one, such as the GitHub example, and it shows up here.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-3">
                    <Field disabled={saving} className="min-w-36 flex-1">
                      <FieldLabel>Plugin</FieldLabel>
                      <Select
                        items={Object.fromEntries(withSources.map((each) => [each.name, each.name]))}
                        value={plugin}
                        onValueChange={(value: string | null) => {
                          if (value === null) return;
                          setPlugin(value);
                          setEvent(withSources.find((each) => each.name === value)?.sources?.[0]?.name ?? "");
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Plugin">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {withSources.map((each) => (
                              <SelectItem key={each.name} value={each.name}>
                                {each.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field disabled={saving} className="min-w-36 flex-1">
                      <FieldLabel>Event</FieldLabel>
                      <Select
                        items={Object.fromEntries((pickedPlugin?.sources ?? []).map((each) => [each.name, each.description]))}
                        value={event}
                        onValueChange={(value: string | null) => {
                          if (value !== null) setEvent(value);
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Event">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {(pickedPlugin?.sources ?? []).map((each) => (
                              <SelectItem key={each.name} value={each.name}>
                                {each.description}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {picked?.followedOnly === true ? (
                    <p className="text-sm text-muted-foreground">Only reaches a task that already follows the thread, such as a pull request the agent opened.</p>
                  ) : null}
                  {picked?.filter === undefined ? null : (
                    <Field disabled={saving} invalid={shown(problems.filter) !== undefined}>
                      <FieldLabel>Filter</FieldLabel>
                      <FieldDescription>{picked.filter}</FieldDescription>
                      <Input className="font-mono" value={filter} onChange={(change) => setFilter(change.target.value)} />
                      <FieldError>{shown(problems.filter)}</FieldError>
                    </Field>
                  )}
                </>
              )
            ) : null}

            {kind === "webhook" ? (
              <p className="text-sm text-muted-foreground">
                Takes signed POSTs from your LAN and tailnet. Its URL and secret show once, after you add it.
              </p>
            ) : null}

            {kind === "schedule" ? null : (
              <div role="group" aria-labelledby={trustId} className="flex flex-col gap-2">
                <p id={trustId} className="text-sm font-medium">
                  Tasks from this source can use
                </p>
                <RadioGroup value={trusted ? "all" : "restricted"} onValueChange={(value) => setTrusted(value === "all")} disabled={saving}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="restricted" />
                    <FieldContent>
                      <FieldLabel>Restricted tools</FieldLabel>
                      <FieldDescription>Someone else wrote it. Reading is fine; installing packages or reaching the network waits for you.</FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="all" />
                    <FieldContent>
                      <FieldLabel>All tools</FieldLabel>
                      <FieldDescription>Like a task you submit yourself.</FieldDescription>
                    </FieldContent>
                  </Field>
                </RadioGroup>
              </div>
            )}
            <FormError>{error}</FormError>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onClose()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!connected || nothingToPick}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
