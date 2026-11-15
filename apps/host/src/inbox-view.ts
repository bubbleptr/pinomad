// The `inbox` host stream and the calls behind the Tasks page and the intake
// (5.38, ADR-0051 §2, §6, §11): every registered project's Inbox as clients
// see it, from the Inbox and timer documents and each project's rules file.
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import {
  INBOX_RULES_MAX_BYTES,
  type HostInbox,
  type InboxTask as WireTask,
  type ProjectInbox as WireInbox,
} from "@pinomad/protocol/inbox.ts";
import type { HostIndex } from "@pinomad/protocol/organization.ts";
import { Published, type HostValue } from "./host-value.ts";
import { cancelFollowUp, type InboxHandle, InboxDoc, type InboxTask, type InboxTimer, type ProjectInbox, projectKey, skipInboxTask, TimerDoc } from "./inbox.ts";
import { memoryDir, readRules, writeRules } from "./inbox-memory.ts";
import { IndexDoc } from "./organization.ts";

/** The gateway's view of the Inboxes: the stream's value and its calls. */
export interface InboxService extends HostValue<HostInbox> {
  sendToIntake(project: string, text: string, requestId: string, context: Context): Promise<ConversationId>;
  setRules(project: string, rules: string): Promise<void>;
  cancelFollowUp(timerId: string, context: Context): Promise<void>;
  skipTask(project: string, taskId: string, context: Context): Promise<void>;
}

const wireTask = (task: Readonly<InboxTask>): WireTask => ({
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

/** The stream's value: one entry per registered project, in the index's order. */
export function hostInbox(
  index: Readonly<HostIndex> | null,
  inboxes: Readonly<Record<string, Readonly<ProjectInbox>>>,
  timers: readonly Readonly<InboxTimer>[],
  rules: ReadonlyMap<string, string>,
): HostInbox {
  return {
    inboxes: (index?.projects ?? []).map(({ path }): WireInbox => {
      const inbox = inboxes[path];
      return {
        project: path,
        ...(inbox?.intake === undefined ? {} : { intake: inbox.intake }),
        tasks: (inbox?.tasks ?? []).map(wireTask),
        threads: { ...inbox?.threads },
        rules: rules.get(path) ?? "",
        followUps: timers
          .filter((timer) => !timer.done && timer.project === path)
          .sort((a, b) => a.due - b.due)
          .map(wireFollowUp),
      };
    }),
  };
}

/**
 * Watch the documents and keep the stream current. `sendToIntake` goes to the
 * Inbox workers, which start after the gateway: until then it is refused.
 */
export async function openInboxService(options: {
  readonly harness: Harness;
  readonly dataDir: string;
  readonly context: Context;
  readonly intake: () => Pick<InboxHandle, "sendToIntake"> | undefined;
}): Promise<InboxService & { close(): void }> {
  const { harness, dataDir, context } = options;
  await harness.commit(async (tx) => {
    await tx.doc(InboxDoc);
    await tx.doc(TimerDoc);
  }, context);
  const indexWatch = await harness.watchDoc(IndexDoc, context);
  const inboxWatch = await harness.watchDoc(InboxDoc, context);
  const timerWatch = await harness.watchDoc(TimerDoc, context);
  if (indexWatch === undefined || inboxWatch === undefined || timerWatch === undefined) throw new Error("Inbox documents are not available");

  let index = indexWatch.value;
  let inboxes = inboxWatch.value?.inboxes ?? {};
  let timers = timerWatch.value?.timers ?? [];
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
  const published = new Published<HostInbox>(hostInbox(index, inboxes, timers, rules), (a, b) => JSON.stringify(a) === JSON.stringify(b));

  // Serialized: reading a new project's rules is async, and an older pass must not publish over a newer one.
  let tail = Promise.resolve();
  const refresh = (): void => {
    tail = tail
      .then(async () => {
        for (const project of index?.projects ?? []) await readFor(project.path);
        published.set(hostInbox(index, inboxes, timers, rules));
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
    cancelFollowUp: (timerId, ctx) => cancelFollowUp(harness, timerId, ctx),
    skipTask: (project, taskId, ctx) => skipInboxTask(harness, project, taskId, ctx),
    close() {
      indexWatch.stop();
      inboxWatch.stop();
      timerWatch.stop();
    },
  };
}
