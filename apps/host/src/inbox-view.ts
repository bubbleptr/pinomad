// The `inbox` host stream and the calls behind the Tasks page and the intake
// (5.38, ADR-0051 §2, §6, §11): every registered project's Inbox as clients
// see it, from the Inbox, timer and source documents and each project's rules
// file. Event sources and their calls arrived in 5.39 (ADR-0051 §10).
import type { Context } from "@earendil-works/chord/context";
import type { ConversationDocToken, ConversationId, Harness } from "@earendil-works/pi-durable";
import {
  INBOX_RULES_MAX_BYTES,
  type HostInbox,
  type InboxQuestion,
  type InboxSource as WireSource,
  type InboxSourceSpec,
  type InboxTask as WireTask,
  type InboxWebhookAccess,
  type ProjectInbox as WireInbox,
} from "@pinomad/protocol/inbox.ts";
import type { HostIndex } from "@pinomad/protocol/organization.ts";
import type { QuestionState } from "@pinomad/protocol/presentation.ts";
import { Published, type HostValue } from "./host-value.ts";
import {
  cancelFollowUp,
  ensureBaseBranch,
  type InboxHandle,
  InboxDoc,
  type InboxTask,
  type InboxTimer,
  type ProjectInbox,
  projectKey,
  setBaseBranch,
  skipInboxTask,
  TimerDoc,
} from "./inbox.ts";
import { memoryDir, readRules, writeRules } from "./inbox-memory.ts";
import {
  addInboxSource,
  type InboxSourceRecord,
  removeInboxSource,
  resetInboxWebhookSecret,
  setInboxSourceEnabled,
  type SourceDeps,
  SourcesDoc,
} from "./inbox-sources.ts";
import { IndexDoc } from "./organization.ts";

/** The gateway's view of the Inboxes: the stream's value and its calls. */
export interface InboxService extends HostValue<HostInbox> {
  sendToIntake(project: string, text: string, requestId: string, context: Context): Promise<ConversationId>;
  prepareIntake(conversationId: ConversationId, context: Context): Promise<void>;
  setRules(project: string, rules: string): Promise<void>;
  setBaseBranch(project: string, branch: string | null, context: Context): Promise<void>;
  cancelFollowUp(timerId: string, context: Context): Promise<void>;
  skipTask(project: string, taskId: string, context: Context): Promise<void>;
  addSource(
    input: { project: string; name: string; trusted: boolean; spec: InboxSourceSpec },
    context: Context,
  ): Promise<{ sourceId: string; webhook?: InboxWebhookAccess }>;
  setSourceEnabled(sourceId: string, enabled: boolean, context: Context): Promise<void>;
  removeSource(sourceId: string, context: Context): Promise<void>;
  resetWebhookSecret(sourceId: string, context: Context): Promise<InboxWebhookAccess>;
}

/** A conversation's unanswered questions, by its id. */
type QuestionsOf = (conversationId: ConversationId) => readonly InboxQuestion[];

const wireTask = (task: Readonly<InboxTask>, questionsOf: QuestionsOf): WireTask => {
  const questions = task.conversationId === undefined || task.closed ? [] : questionsOf(task.conversationId);
  return {
    ...wireTaskFields(task),
    ...(questions.length === 0 ? {} : { questions }),
  };
};

const wireTaskFields = (task: Readonly<InboxTask>): WireTask => ({
  id: task.id,
  title: task.title,
  createdAt: task.createdAt,
  ...(task.conversationId === undefined ? {} : { conversationId: task.conversationId }),
  events: task.events.map((event) => ({
    id: event.id,
    source: event.source,
    ...(event.thread === undefined ? {} : { thread: event.thread }),
    summary: event.summary,
    trusted: event.trusted,
    receivedAt: event.receivedAt,
    handled: event.handled,
  })),
  // The batch's request ids are the worker's; clients only need to know one is out.
  ...(task.batch === undefined ? {} : { inFlight: true as const }),
  closed: task.closed,
  ...(task.skipped === true ? { skipped: true as const } : {}),
  ...(task.failed === undefined ? {} : { failed: task.failed }),
  ...(task.waiting === true ? { waiting: true as const } : {}),
  ...(task.kind === undefined ? {} : { kind: task.kind }),
});

const wireFollowUp = (timer: Readonly<InboxTimer>) => ({
  id: timer.id,
  due: timer.due,
  note: timer.note,
  ...(timer.task === undefined ? {} : { task: timer.task }),
  ...(timer.every === undefined ? {} : { every: timer.every }),
  ...(timer.kind === undefined ? {} : { kind: timer.kind }),
});

const wireSource = (source: Readonly<InboxSourceRecord>, timers: readonly Readonly<InboxTimer>[]): WireSource => {
  const timer = source.spec.kind === "schedule" ? timers.find((each) => each.source === source.id && !each.done) : undefined;
  return {
    id: source.id,
    name: source.name,
    spec: source.spec,
    enabled: source.enabled,
    trusted: source.trusted,
    createdAt: source.createdAt,
    ...(timer === undefined ? {} : { next: timer.due }),
    ...(source.problem === undefined ? {} : { problem: source.problem }),
  };
};

/** The stream's value: one entry per registered project, in the index's order. */
export function hostInbox(
  index: Readonly<HostIndex> | null,
  inboxes: Readonly<Record<string, Readonly<ProjectInbox>>>,
  timers: readonly Readonly<InboxTimer>[],
  rules: ReadonlyMap<string, string>,
  sources: readonly Readonly<InboxSourceRecord>[],
  questionsOf: QuestionsOf = () => [],
): HostInbox {
  return {
    // Plugin and webhook sources are always taken; the field stays for clients that read it.
    externalSources: true,
    inboxes: (index?.projects ?? []).map(({ path }): WireInbox => {
      const inbox = inboxes[path];
      return {
        project: path,
        ...(inbox?.intake === undefined ? {} : { intake: inbox.intake }),
        ...(inbox?.baseBranch === undefined ? {} : { baseBranch: inbox.baseBranch }),
        tasks: (inbox?.tasks ?? []).map((task) => wireTask(task, questionsOf)),
        threads: { ...inbox?.threads },
        rules: rules.get(path) ?? "",
        followUps: timers
          .filter((timer) => !timer.done && timer.project === path && timer.source === undefined)
          .sort((a, b) => a.due - b.due)
          .map(wireFollowUp),
        sources: sources.filter((source) => source.project === path).map((source) => wireSource(source, timers)),
      };
    }),
  };
}

/**
 * Watch the documents and keep the stream current. `sendToIntake` goes to the
 * Inbox workers, which start after the gateway: until then it is refused.
 */
export async function openInboxService(options: {
  readonly dataDir: string;
  readonly context: Context;
  readonly intake: () => Pick<InboxHandle, "sendToIntake" | "prepareIntake"> | undefined;
  /** The source calls' dependencies; `harness` is the host's. */
  readonly sources: SourceDeps;
  /** The installed `pinomad.question` documents: an open task's unanswered requests go into the stream (#846). */
  readonly questionDocs?: readonly ConversationDocToken<QuestionState>[];
}): Promise<InboxService & { close(): void }> {
  const { dataDir, context } = options;
  const { harness } = options.sources;
  await harness.commit(async (tx) => {
    await tx.doc(InboxDoc);
    await tx.doc(TimerDoc);
    await tx.doc(SourcesDoc);
  }, context);
  const indexWatch = await harness.watchDoc(IndexDoc, context);
  const inboxWatch = await harness.watchDoc(InboxDoc, context);
  const timerWatch = await harness.watchDoc(TimerDoc, context);
  const sourceWatch = await harness.watchDoc(SourcesDoc, context);
  if (indexWatch === undefined || inboxWatch === undefined || timerWatch === undefined || sourceWatch === undefined) {
    throw new Error("Inbox documents are not available");
  }

  let index = indexWatch.value;
  let inboxes = inboxWatch.value?.inboxes ?? {};
  let timers = timerWatch.value?.timers ?? [];
  let sources = sourceWatch.value?.sources ?? [];
  const value = (): HostInbox => hostInbox(index, inboxes, timers, rules, sources, questionsOf);

  // Each open task's question documents, watched while the task is open, so a
  // question shows (and an answer clears) in the stream as it happens.
  const questionWatches = new Map<ConversationId, Map<string, { value: Readonly<QuestionState> | null; stop(): void }>>();
  const questionsOf: QuestionsOf = (id) =>
    [...(questionWatches.get(id)?.entries() ?? [])].flatMap(([kind, watch]) =>
      (watch.value?.requests ?? []).filter((request) => request.resolution === undefined).map((request) => ({ kind, request })),
    );
  let closed = false;
  const syncQuestionWatches = async (): Promise<void> => {
    const open = new Set(
      Object.values(inboxes).flatMap((inbox) =>
        inbox.tasks.filter((task) => !task.closed && task.conversationId !== undefined).map((task) => task.conversationId!),
      ),
    );
    for (const [id, watches] of questionWatches) {
      if (open.has(id)) continue;
      for (const watch of watches.values()) watch.stop();
      questionWatches.delete(id);
    }
    for (const id of open) {
      let watches = questionWatches.get(id);
      if (watches === undefined) questionWatches.set(id, (watches = new Map()));
      for (const token of options.questionDocs ?? []) {
        const kind = token.definition.kind;
        if (watches.has(kind)) continue;
        // Absent until the conversation's first question: the next change to the Inbox tries again.
        const watch = await harness.watchDoc(token, id, context);
        if (watch === undefined) continue;
        if (closed || questionWatches.get(id) !== watches) {
          watch.stop();
          continue;
        }
        const entry = { value: watch.value, stop: () => watch.stop() };
        watches.set(kind, entry);
        watch.start((call) => {
          if (call.kind === "value") {
            entry.value = call.value;
            refresh();
          }
          return Promise.resolve();
        });
      }
    }
  };
  /** Projects whose default base branch was looked for in this process: once is enough (#846). */
  const baseLooked = new Set<string>();
  /** Each project's rules, read once and then kept by `setRules`. */
  const rules = new Map<string, string>();
  const readFor = async (path: string): Promise<void> => {
    if (rules.has(path)) return;
    try {
      rules.set(path, await readRules(memoryDir(dataDir, path)));
    } catch (error) {
      console.error(`Inbox rules for ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      rules.set(path, "");
    }
  };
  for (const project of index?.projects ?? []) await readFor(project.path);
  const published = new Published<HostInbox>(value(), (a, b) => JSON.stringify(a) === JSON.stringify(b));

  // Serialized: reading a new project's rules is async, and an older pass must not publish over a newer one.
  let tail = Promise.resolve();
  const refresh = (): void => {
    tail = tail
      .then(async () => {
        for (const project of index?.projects ?? []) await readFor(project.path);
        await syncQuestionWatches();
        // Found and stored for each git project up front, so the Inbox shows its branch before the first task.
        for (const { path } of index?.projects ?? []) {
          if (inboxes[path]?.baseBranch !== undefined || baseLooked.has(path)) continue;
          baseLooked.add(path);
          await ensureBaseBranch(harness, path, context).catch((error: unknown) =>
            console.error(`Inbox base branch for ${path} could not be found: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
        published.set(value());
      })
      .catch((error: unknown) => console.error("Inbox stream could not refresh:", error));
  };
  indexWatch.start((call) => {
    if (call.kind === "value") {
      index = call.value;
      refresh();
    }
    return Promise.resolve();
  });
  inboxWatch.start((call) => {
    if (call.kind === "value") {
      inboxes = call.value?.inboxes ?? {};
      refresh();
    }
    return Promise.resolve();
  });
  timerWatch.start((call) => {
    if (call.kind === "value") {
      timers = call.value?.timers ?? [];
      refresh();
    }
    return Promise.resolve();
  });
  sourceWatch.start((call) => {
    if (call.kind === "value") {
      sources = call.value?.sources ?? [];
      refresh();
    }
    return Promise.resolve();
  });

  // Once now, for what the first refresh does beyond publishing: the base branches and question watches.
  refresh();

  let writes: Promise<void> = Promise.resolve();

  /** A registered project's key, or a refusal. */
  const registered = async (project: string): Promise<string> => {
    const key = await projectKey(project);
    if (!(index?.projects ?? []).some((each) => each.path === key)) throw new Error(`Unknown project: ${project}`);
    return key;
  };

  return {
    get value() {
      return published.value;
    },
    subscribe: (listener) => published.subscribe(listener),
    sendToIntake: async (project, text, requestId, ctx) => {
      const intake = options.intake();
      if (intake === undefined) throw new Error("The Inbox is still starting");
      return await intake.sendToIntake(project, text, requestId, ctx);
    },
    // Before the workers start there is no intake to prepare: a message then reads the checkout as it is.
    prepareIntake: async (conversationId, ctx) => await options.intake()?.prepareIntake(conversationId, ctx),
    setRules: async (project, text) => {
      if (Buffer.byteLength(text, "utf8") > INBOX_RULES_MAX_BYTES) {
        throw new Error(`The rules are too long: at most ${INBOX_RULES_MAX_BYTES / 1024} KB`);
      }
      const key = await registered(project);
      // One write at a time: two saves share the tmp name, and the cache must end as the disk does.
      const write = writes.catch(() => {}).then(async () => {
        await writeRules(memoryDir(dataDir, key), text);
        rules.set(key, text);
      });
      writes = write;
      await write;
      refresh();
      await tail;
    },
    setBaseBranch: async (project, branch, ctx) => {
      const key = await registered(project);
      await setBaseBranch(harness, key, branch, ctx);
    },
    cancelFollowUp: (timerId, ctx) => cancelFollowUp(harness, timerId, ctx),
    skipTask: (project, taskId, ctx) => skipInboxTask(harness, project, taskId, ctx),
    addSource: (input, ctx) => addInboxSource(options.sources, input, ctx),
    setSourceEnabled: (sourceId, enabled, ctx) => setInboxSourceEnabled(options.sources, sourceId, enabled, ctx),
    removeSource: (sourceId, ctx) => removeInboxSource(options.sources, sourceId, ctx),
    resetWebhookSecret: (sourceId, ctx) => resetInboxWebhookSecret(options.sources, sourceId, ctx),
    close() {
      closed = true;
      for (const watches of questionWatches.values()) for (const watch of watches.values()) watch.stop();
      questionWatches.clear();
      indexWatch.stop();
      inboxWatch.stop();
      timerWatch.stop();
      sourceWatch.stop();
    },
  };
}
