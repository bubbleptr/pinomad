// The Tasks surface's Inbox part (ADR-0051 §11, ADR-0040 §1): the project
// Inbox's processing rules, its event sources and the follow-ups not yet
// fired.
import { useId, useState } from "react";
import { INBOX_RULES_MAX_BYTES, type InboxFollowUp, type ProjectInbox } from "@pinomad/protocol/inbox.ts";
import type { PluginInfo } from "@pinomad/protocol/frames.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { Button } from "../../shared/ui/button.tsx";
import { Field, FieldError, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { Bell, Cancel, Clock } from "../../shared/ui/icons.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../shared/ui/item.tsx";
import { Textarea } from "../../shared/ui/textarea.tsx";
import { useErrorToast } from "../../shared/ui/toast.tsx";
import { messageTime } from "../chat/chat-time.ts";
import { SourcesSection } from "./inbox-sources.tsx";

export function InboxSections({
  inbox,
  remote,
  connected,
  plugins,
  externalSources,
}: {
  inbox: ProjectInbox;
  remote: RemoteDurable;
  connected: boolean;
  /** The host's loaded plugins, for their event sources. */
  plugins: readonly PluginInfo[];
  /** The host takes plugin and webhook sources (it has a sandbox for Inbox runs). */
  externalSources: boolean;
}) {
  return (
    <div className="flex flex-col">
      <RulesSection inbox={inbox} remote={remote} connected={connected} />
      <SourcesSection inbox={inbox} remote={remote} connected={connected} plugins={plugins} externalSources={externalSources} />
      <FollowUpsSection inbox={inbox} remote={remote} connected={connected} />
    </div>
  );
}

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="text-xs/5 font-medium text-muted-foreground">
      {children}
    </h3>
  );
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The rules every task of this Inbox reads first; edited in place, saved whole. */
function RulesSection({ inbox, remote, connected }: { inbox: ProjectInbox; remote: RemoteDurable; connected: boolean }) {
  const heading = useId();
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const tooLong = draft !== undefined && utf8Bytes(draft) > INBOX_RULES_MAX_BYTES;
  const save = (): void => {
    if (draft === undefined || tooLong) return;
    setSaving(true);
    setError(undefined);
    remote.controller.setInboxRules(inbox.project, draft.trim()).then(
      () => {
        setSaving(false);
        setDraft(undefined);
      },
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1.5 px-3 py-3">
      <div className="flex min-h-7 items-center gap-2">
        <SectionHeading id={heading}>Rules</SectionHeading>
        {draft !== undefined ? null : (
          <Button
            className="ms-auto"
            variant="secondary"
            size="sm"
            disabled={!connected}
            onClick={() => {
              setError(undefined);
              setDraft(inbox.rules);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {draft === undefined ? (
        <>
          {inbox.rules === "" ? (
            <p className="text-sm/5 text-muted-foreground">No rules yet.</p>
          ) : (
            <p className="text-sm/5 whitespace-pre-wrap">{inbox.rules}</p>
          )}
          <p className="text-xs/5 text-muted-foreground">Every task reads these when it starts, along with the project's AGENTS.md.</p>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field invalid={tooLong}>
            <FieldLabel className="sr-only">Rules</FieldLabel>
            <Textarea
              // Edit was just pressed: the box it opened takes the focus.
              autoFocus
              rows={5}
              value={draft}
              placeholder="Write a failing test first. Ask before database migrations."
              onChange={(event) => setDraft(event.target.value)}
            />
            <FieldError>{tooLong ? `At most ${INBOX_RULES_MAX_BYTES / 1024} KB` : undefined}</FieldError>
          </Field>
          <FormError>{error}</FormError>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!connected || tooLong}>
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function periodText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function followUpDescription(followUp: InboxFollowUp, inbox: ProjectInbox): string {
  const due = messageTime(followUp.due)?.label ?? "";
  if (followUp.every !== undefined) return `${periodText(followUp.every)} · next ${due}`;
  const task = followUp.task === undefined ? undefined : inbox.tasks.find((each) => each.id === followUp.task);
  return task === undefined ? due : `${due} · set by “${task.title}”`;
}

/** Timers not yet fired, soonest first. Each can be cancelled except the daily memory tidy-up. */
function FollowUpsSection({ inbox, remote, connected }: { inbox: ProjectInbox; remote: RemoteDurable; connected: boolean }) {
  const heading = useId();
  const error = useErrorToast();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const cancel = (followUp: InboxFollowUp): void => {
    error.clear();
    setCancelling((prev) => new Set(prev).add(followUp.id));
    remote.controller.cancelFollowUp(followUp.id).catch((reason: unknown) => {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(followUp.id);
        return next;
      });
      error.show(`Couldn't cancel “${followUp.note}”: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1 border-t border-border px-3 pt-3 pb-2">
      <SectionHeading id={heading}>Follow-ups</SectionHeading>
      {inbox.followUps.length === 0 ? (
        <p className="text-sm/5 text-muted-foreground">None scheduled.</p>
      ) : (
        <ItemGroup aria-labelledby={heading} className="-mx-3">
          {inbox.followUps.map((followUp) => (
            <Item key={followUp.id} size="sm" render={<li />}>
              <ItemMedia>
                {followUp.every === undefined ? (
                  <Bell aria-hidden="true" className="size-4 text-muted-foreground" />
                ) : (
                  <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{followUp.note}</ItemTitle>
                <ItemDescription>{followUpDescription(followUp, inbox)}</ItemDescription>
              </ItemContent>
              {followUp.kind === "tidy" ? null : (
                <ItemActions>
                  <IconButton
                    icon={<Cancel aria-hidden="true" />}
                    label={`Cancel follow-up: ${followUp.note}`}
                    tooltip="Cancel"
                    size="sm"
                    variant="ghost"
                    disabled={!connected || cancelling.has(followUp.id)}
                    onClick={() => cancel(followUp)}
                  />
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
