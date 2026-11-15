import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxTask, ProjectInbox } from "@pinomad/protocol/inbox.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { TaskQuestions } from "./task-questions.tsx";

const task = (id: string, title: string, conversationId: number, questions?: InboxTask["questions"]): InboxTask => ({
  id,
  title,
  createdAt: 0,
  conversationId: conversationId as ConversationId,
  events: [],
  closed: false,
  ...(questions === undefined ? {} : { waiting: true as const, questions }),
});

const asking = task("t1", "Layout breaks on desktop", 7, [
  {
    kind: "question.requests",
    request: { id: "req-1", askedAt: 0, questions: [{ header: "Scope", question: "Change desktop too?", options: [{ label: "Yes" }, { label: "No" }] }] },
  },
]);

const inbox = (tasks: InboxTask[]): ProjectInbox => ({ project: "/p", tasks, threads: {}, rules: "", followUps: [] });

describe("TaskQuestions", () => {
  beforeAll(() => {
    HTMLElement.prototype.animate ??= vi.fn() as unknown as HTMLElement["animate"];
  });

  it("shows nothing when no task is asking", () => {
    const { container } = render(
      <TaskQuestions inbox={inbox([task("t0", "Quiet", 3)])} remote={{} as RemoteDurable} connected onOpenTask={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("answers a task's question on that task's conversation, and opens the task", async () => {
    const answer = vi.fn(() => Promise.resolve());
    const onOpenTask = vi.fn();
    const user = userEvent.setup();
    render(<TaskQuestions inbox={inbox([task("t0", "Quiet", 3), asking])} remote={{ controller: { answer } } as unknown as RemoteDurable} connected onOpenTask={onOpenTask} />);
    expect(screen.getByText("Change desktop too?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Layout breaks on desktop" }));
    expect(onOpenTask).toHaveBeenCalledWith(asking);
    await user.click(screen.getByRole("radio", { name: /Yes/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(answer).toHaveBeenCalledWith("question.requests", "req-1", [{ selected: ["Yes"] }], 7);
  });
});
