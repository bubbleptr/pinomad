import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SubmissionDraft } from "@pinomad/protocol/view.ts";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { ConversationComposer } from "./conversation-composer.tsx";
import { canTakeBackInSidePanel, takeBackForConversation, type PendingTakeBack } from "./take-back.ts";

const draft: SubmissionDraft = {
  text: "restored draft",
  whenBusy: "followUp",
  images: [],
  skills: [],
  attachments: [],
};

describe("takeBackForConversation", () => {
  it("only returns a draft to the conversation it came from", () => {
    const origin = 7 as ConversationId;
    const other = 8 as ConversationId;
    const pending: PendingTakeBack = { conversationId: origin, draft };
    expect(takeBackForConversation(pending, other)).toBeUndefined();
    expect(takeBackForConversation(pending, undefined)).toBeUndefined();
    expect(takeBackForConversation(pending, origin)).toBe(draft);
  });

  it("only lets the side composer take back a submission with no attachments", () => {
    expect(canTakeBackInSidePanel({ images: [], attachments: [] }, false)).toBe(true);
    expect(canTakeBackInSidePanel({ images: [], attachments: ["A"] }, false)).toBe(false);
    expect(canTakeBackInSidePanel({ images: [{ ref: "r1" }], attachments: [] }, false)).toBe(false);
    expect(canTakeBackInSidePanel({ images: [], attachments: [] }, true)).toBe(false);
  });

  it("leaves a new chat empty and restores the draft on the origin conversation", async () => {
    const view = fakeView();
    const remote = fakeRemote(view);
    const pending: PendingTakeBack = {
      conversationId: view.conversation!.conversation.id,
      draft,
    };

    const { rerender } = render(<div>New chat</div>);
    expect(screen.queryByText("restored draft")).toBeNull();

    rerender(
      <ConversationComposer
        view={view}
        remote={remote}
        conversation={view.conversation!}
        busy={false}
        narrow={false}
        takeBack={takeBackForConversation(pending, view.conversation!.conversation.id)}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>('[aria-multiline="true"]')?.textContent).toBe("restored draft"),
    );
  });
});
