// Command outcomes that RemoteDurable swallows: a refused command still
// resolves (the error becomes a view notice), so callers that need to know
// must check the shown conversation afterwards. Commands are serialized and
// switch updates the view synchronously, so reading after `await` is reliable.
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Home } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

type Remote = Pick<RemoteDurable, "view" | "controller">;

const shownId = (remote: Remote): ConversationId | undefined =>
  remote.view.current().conversation?.conversation.id;

type CreateOptions = Parameters<RemoteDurable["controller"]["createConversation"]>[2];

/**
 * Create, show, and resolve with the new conversation's id. Throws when the
 * shown conversation didn't change — the create failed and the caller keeps
 * its draft (the toast surfaces the host's reason).
 */
export async function createAndShow(
  remote: Remote,
  home: Home,
  text: string,
  options?: CreateOptions,
): Promise<ConversationId> {
  const before = shownId(remote);
  await remote.controller.createConversation(home, text, options);
  const after = shownId(remote);
  if (after === undefined || after === before) {
    throw new Error("Couldn't start the conversation");
  }
  return after;
}

/**
 * Switch and report whether `id` is now shown. False means the host refused
 * (closed/archived/not-found); the reason is a notice on the view.
 */
export async function showConversation(remote: Remote, id: ConversationId): Promise<boolean> {
  await remote.controller.switchConversation(id);
  return shownId(remote) === id;
}
