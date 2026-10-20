import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "@pinomad/protocol/presentation.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { QuestionCard } from "./question.tsx";

const request: QuestionRequest = {
  id: "req-1",
  askedAt: 0,
  questions: [
    {
      header: "Auth",
      question: "Which auth should the upload API use?",
      options: [
        { label: "Bearer tokens", description: "Short-lived token from the refresh flow." },
        { label: "Session cookies" },
      ],
    },
    {
      header: "Tests",
      multiSelect: true,
      question: "Which test layers should cover it?",
      options: [{ label: "Unit" }, { label: "End-to-end" }],
    },
    {
      header: "Rollout",
      question: "Ship it behind a flag?",
      options: [{ label: "Flag, default off" }, { label: "Ship directly" }],
    },
  ],
};

function setup(answer = vi.fn(() => Promise.resolve())) {
  const remote = { controller: { answer } } as unknown as RemoteDurable;
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(<QuestionCard kind="question.requests" request={request} remote={remote} connected />);
  return { user, answer, ...view };
}

/** The question in view, by its tab in the progress indicator. */
const current = (): string | undefined =>
  screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-label") ?? undefined;

const advance = (): void => {
  act(() => {
    vi.advanceTimersByTime(1000);
  });
};

describe("QuestionCard", () => {
  beforeAll(() => {
    // jsdom has neither Web Animations nor the font loading API.
    HTMLElement.prototype.animate ??= vi.fn() as unknown as HTMLElement["animate"];
    if (!("fonts" in document)) Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() } });
  });
  beforeEach(() => {
    // Testing Library waits on a real-looking setTimeout(0) after each event;
    // let fake time drift with real time so that wait ends.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves on by itself when a single-choice option is tapped", async () => {
    const { user } = setup();
    expect(current()).toMatch(/^Auth/);

    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    advance();

    expect(current()).toMatch(/^Tests/);
  });

  it("takes a single-choice answer back when the picked option is tapped again, without moving on", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    advance();
    await user.click(screen.getByRole("button", { name: "Back" }));
    advance();

    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    advance();

    expect(screen.getByRole("radio", { name: "Bearer tokens" })).not.toBeChecked();
    expect(current()).toMatch(/^Auth/);
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
  });

  it("keeps the footer's action while a pick is about to move on, so it changes only once", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));

    // Answered, but still on the question: no flash of "Next" before the page moves.
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("lets go of the held action when Other replaces a pick that was about to move on", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    await user.click(screen.getAllByRole("radio", { name: "Other" })[0]!);
    advance();

    await user.click(screen.getAllByRole("tab")[2]!);
    advance();

    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
  });

  it("drops a pick's pending move when the person navigates first", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    await user.click(screen.getAllByRole("tab")[2]!);
    advance();

    expect(current()).toMatch(/^Rollout/);
  });

  it("drops a pick's pending move when the person swipes the pager", async () => {
    const { user, container } = setup();
    const pager = container.querySelector(".question-card__pager")!;

    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    fireEvent.touchStart(pager, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(pager, { touches: [{ clientX: 160, clientY: 102 }] });
    advance();
    expect(current()).toMatch(/^Auth/);

    await user.click(screen.getByRole("radio", { name: "Session cookies" }));
    fireEvent.wheel(pager, { deltaX: 30, deltaY: 2 });
    advance();
    expect(current()).toMatch(/^Auth/);
  });

  it("still moves on when the page scrolls vertically over the card", async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));
    fireEvent.wheel(container.querySelector(".question-card__pager")!, { deltaX: 0, deltaY: 40 });
    advance();

    expect(current()).toMatch(/^Tests/);
  });

  it("makes Other exclusive on a single-choice question and sends its text only while it is picked", async () => {
    const { user, answer } = setup();
    // Straight to the last question.
    await user.click(screen.getAllByRole("tab")[2]!);
    advance();

    await user.click(screen.getByRole("radio", { name: "Flag, default off" }));
    await user.click(screen.getAllByRole("radio", { name: "Other" })[1]!);
    await user.type(screen.getByRole("textbox", { name: "Other answer" }), "Ship to staging first");
    expect(screen.getByRole("radio", { name: "Flag, default off" })).not.toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Ship directly" }));
    expect(screen.queryByRole("textbox", { name: "Other answer" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(answer).toHaveBeenCalledWith(
      "question.requests",
      "req-1",
      [{ selected: [] }, { selected: [] }, { selected: ["Ship directly"] }],
      undefined,
    );
  });

  it("lets Other combine with picks on a multi-choice question", async () => {
    const { user, answer } = setup();
    await user.click(screen.getAllByRole("tab")[1]!);
    advance();

    await user.click(screen.getByRole("checkbox", { name: "Unit" }));
    await user.click(screen.getByRole("checkbox", { name: "Other" }));
    await user.type(screen.getByRole("textbox", { name: "Other answer" }), "Contract snapshots");
    await user.click(screen.getByRole("button", { name: "Next" }));
    advance();
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(answer).toHaveBeenCalledWith(
      "question.requests",
      "req-1",
      [{ selected: [] }, { selected: ["Unit"], other: "Contract snapshots" }, { selected: [] }],
      undefined,
    );
  });

  it("sends once while the answer is in flight", async () => {
    const answer = vi.fn(() => new Promise<void>(() => {}));
    const { user } = setup(answer);
    await user.click(screen.getAllByRole("tab")[2]!);
    advance();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(answer).toHaveBeenCalledTimes(1);
  });

  // question.css reaches into Astryx's list markup to tighten the rows; an
  // Astryx upgrade that renames it silently brings the tall rows back.
  it("still finds the Astryx list markup its styles reach into", () => {
    const { container } = setup();
    const options = (selector: string): Element | null => container.querySelector(`.question-card__options ${selector}`);

    // The checkbox list (its rows are inset; the radio list's are not).
    expect(options(".astryx-list input[type='checkbox']")).not.toBeNull();
    expect(options(".astryx-item > span:nth-child(2) > :nth-child(2)")).toHaveTextContent(
      "Short-lived token from the refresh flow.",
    );
  });

  // The request can resolve elsewhere (another client, or a chat reply
  // dismissing it) while a pick's move is still pending.
  it("drops a pending move when the card goes away", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { user, unmount } = setup();
    await user.click(screen.getByRole("radio", { name: "Bearer tokens" }));

    unmount();
    advance();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
