import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxTranscript } from "../../entities/inbox/inbox-transcript.tsx";
import { PINOMAD, TASK } from "../../test/story-fixtures.tsx";
import { InboxTaskCards } from "./inbox-cards.tsx";
import * as stories from "./inbox-cards.stories.tsx";

const { IntakeTaskCards, TaskEvents } = composeStories(stories);

afterEach(cleanup);

describe("intake task cards", () => {
  it("shows each filed task as it stands now, and opens it", async () => {
    const user = userEvent.setup();
    render(<IntakeTaskCards />);
    const cards = within(screen.getByRole("list", { name: "Filed tasks" })).getAllByRole("button");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringMatching(/CSV export garbles Chinese text.*New task · #1 in queue/),
      expect.stringMatching(/Order filters reset after paging.*New task · #2 in queue/),
      expect.stringMatching(/Avatar sometimes missing after sign-in.*Added to task · Working/),
    ]);
    await user.click(cards[0]!);
    expect(IntakeTaskCards.args.onOpenTask).toHaveBeenCalledWith(PINOMAD.path, expect.objectContaining({ id: TASK.queued }));
  });

  it("still renders a call whose arguments have the wrong types", () => {
    const transcript: InboxTranscript = { events: new Map(), task: () => undefined, openTask: () => {} };
    render(
      <InboxTaskCards
        tools={[
          { toolName: "inbox_submit", state: "output-error", argsText: JSON.stringify({ title: { text: "Fix export" }, mergeInto: 7 }) },
        ]}
        inbox={transcript}
      />,
    );
    const card = within(screen.getByRole("list", { name: "Filed tasks" })).getByRole("listitem");
    expect(card).toHaveTextContent(/Task.*Not filed/);
  });
});

describe("a task's conversation", () => {
  it("shows the worker's message as the events it delivered", () => {
    render(<TaskEvents />);
    const card = screen.getByRole("region", { name: "Inbox events" });
    expect(card).toHaveTextContent("From you");
    expect(card).toHaveTextContent("More often on Safari.");
    expect(card).toHaveTextContent(/Received .*Started /);
    // The preface and rules the model reads stay out of the transcript.
    expect(screen.queryByText(/This is a task from the project's Inbox/)).toBeNull();
  });
});
