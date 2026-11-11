// Pending `pinomad.question` requests (ADR-0011): rendered above the composer so
// the agent's question is unmissable on any screen size. A request is one card
// that pages through its questions — swipe, the segments under it, Back, or a
// tap on a single-choice option, which moves on by itself. One Submit sends
// every question's answers at once; untouched questions count as skipped. The
// resolved read-only view lives in documents.tsx.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../shared/ui/button.tsx";
import { Checkbox } from "../shared/ui/checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../shared/ui/field.tsx";
import { RadioGroup, RadioGroupItem } from "../shared/ui/radio-group.tsx";
import { Input } from "../shared/ui/input.tsx";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { QuestionItem, QuestionRequest } from "@pinomad/protocol/presentation.ts";
import { pendingQuestions, questionAnswers } from "@pinomad/client/questions.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ExtensionDocView } from "@pinomad/protocol/view.ts";
import { prefersReducedMotion, useQuestionPager } from "./use-question-pager.ts";

/** The Other row's value: the last option of every question, never a real label. */
const OTHER = "\u0000other";
/** Long enough for a tap to visibly land before the page moves. */
const ADVANCE_MS = 250;

type Action = "submit" | "next" | "skip";

/** Unresolved question requests across a conversation's doc views, in doc order.
    `target` defaults the answers to the main shown conversation — the side
    panel passes its own conversation so a fork can be answered in place. */
export function PendingQuestions({
  docs,
  remote,
  connected,
  target,
}: {
  docs: readonly ExtensionDocView[];
  remote: RemoteDurable;
  connected: boolean;
  target?: ConversationId;
}) {
  const pending = pendingQuestions(docs);
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 p-2" data-testid="pending-questions">
      {pending.map(({ kind, request }) => (
        <QuestionCard key={request.id} kind={kind} request={request} remote={remote} connected={connected} target={target} />
      ))}
    </div>
  );
}

export function QuestionCard({
  kind,
  request,
  remote,
  connected,
  target,
}: {
  kind: string;
  request: QuestionRequest;
  remote: RemoteDurable;
  connected: boolean;
  target?: ConversationId;
}) {
  const count = request.questions.length;
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => request.questions.map(() => ""));
  // Other's text only counts while its row is picked.
  const [otherOn, setOtherOnAll] = useState<boolean[]>(() => request.questions.map(() => false));
  const [sending, setSending] = useState(false);
  // State lags a render behind; two clicks in one task would both see `false`.
  const sendingNow = useRef(false);
  const setSelection = (index: number, selected: string[]): void =>
    setSelections((prev) => prev.map((each, i) => (i === index ? selected : each)));
  const setOther = (index: number, text: string): void => setOthers((prev) => prev.map((each, i) => (i === index ? text : each)));
  const setOtherOn = (index: number, on: boolean): void =>
    setOtherOnAll((prev) => prev.map((each, i) => (i === index ? on : each)));
  const answered = (index: number): boolean =>
    (selections[index]?.length ?? 0) > 0 || (otherOn[index] === true && (others[index] ?? "").trim() !== "");

  const pager = useQuestionPager(count);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // While a pick's move is pending the footer keeps the action it showed
  // before the pick, so it changes once (on the new page), not Skip → Next → Skip.
  const [heldAction, setHeldAction] = useState<Action | null>(null);

  const last = pager.index === count - 1;
  const allAnswered = request.questions.every((_, index) => answered(index));
  const action: Action = last || allAnswered ? "submit" : answered(pager.index) ? "next" : "skip";
  const shown = heldAction ?? action;

  // Any move the person makes — a button, a segment, a key, a swipe —
  // overrides a pick's pending one.
  const cancelPending = (): void => {
    window.clearTimeout(timer.current);
    setHeldAction(null);
  };
  const moveTo = (next: number): void => {
    cancelPending();
    pager.go(next);
  };
  const swipeFrom = useRef<number | null>(null);
  const advance = (): void => moveTo(pager.index + 1);
  const submit = (): void => {
    if (sendingNow.current || !connected) return;
    sendingNow.current = true;
    setSending(true);
    const answers = questionAnswers(
      count,
      selections,
      others.map((text, index) => (otherOn[index] === true ? text : "")),
    );
    // Success resolves the request and this card goes away; a failure lets it be sent again.
    remote.controller.answer(kind, request.id, answers, target).catch(() => {
      sendingNow.current = false;
      setSending(false);
    });
  };
  const pointerPick =
    (index: number) =>
    (value: string, cleared: boolean): void => {
      // A take-back, or a pick that doesn't move on, ends any earlier pick's pending move.
      if (cleared || request.questions[index]?.multiSelect === true || value === OTHER || index + 1 >= count) {
        cancelPending();
        return;
      }
      window.clearTimeout(timer.current);
      setHeldAction((held) => held ?? action);
      timer.current = window.setTimeout(
        () => {
          pager.go(index + 1);
          setHeldAction(null);
        },
        prefersReducedMotion() ? 0 : ADVANCE_MS,
      );
    };

  return (
    <section className="question-card" aria-label="The agent asks" onKeyDown={pagingKeys(pager.index, moveTo)}>
      <div
        ref={pager.ref}
        className="question-card__pager"
        onScroll={pager.onScroll}
        // Only sideways gestures count: scrolling the page past the card is not a swipe.
        onWheel={(event) => {
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) cancelPending();
        }}
        onTouchStart={(event) => {
          swipeFrom.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchMove={(event) => {
          const x = event.touches[0]?.clientX;
          if (swipeFrom.current !== null && x !== undefined && Math.abs(x - swipeFrom.current) > 8) cancelPending();
        }}
      >
        {request.questions.map((question, index) => (
          <div
            key={index}
            className="question-card__page"
            role="group"
            aria-roledescription="question"
            aria-label={`${index + 1} of ${count}: ${question.header}`}
            inert={index !== pager.index}
          >
            <QuestionPage
              question={question}
              selected={selections[index] ?? []}
              other={others[index] ?? ""}
              otherOn={otherOn[index] === true}
              onSelect={(selected) => setSelection(index, selected)}
              onOther={(text) => setOther(index, text)}
              onOtherOn={(on) => setOtherOn(index, on)}
              onPointerPick={pointerPick(index)}
              onOtherEnter={index + 1 < count ? advance : submit}
            />
          </div>
        ))}
      </div>
      <div className="question-card__footer">
        <div className="question-card__back">
          {pager.index > 0 ? <Button variant="secondary" onClick={() => moveTo(pager.index - 1)}>Back</Button> : null}
        </div>
        {count > 1 ? (
          <div className="question-card__segments" role="tablist" aria-label="Questions">
            {request.questions.map((question, index) => (
              <button
                key={index}
                type="button"
                role="tab"
                className="question-card__segment"
                aria-selected={index === pager.index}
                aria-label={`${question.header}, ${answered(index) ? "answered" : "not answered"}`}
                data-current={index === pager.index || undefined}
                data-answered={answered(index) || undefined}
                tabIndex={index === pager.index ? 0 : -1}
                onClick={() => moveTo(index)}
              />
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="question-card__action">
          {shown === "submit" ? (
            <Button variant="primary" disabled={!connected || sending} onClick={submit}>Submit</Button>
          ) : shown === "next" ? (
            <Button variant="secondary" onClick={advance}>Next</Button>
          ) : (
            <Button variant="secondary" onClick={advance}>Skip</Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** One question: the question as the page's heading, its options, and Other
    as the last option — a radio (exclusive) or a checkbox (combinable) whose
    field opens under it. `onPointerPick` fires for pointer taps on a radio
    (new or already picked), never for keyboard moves; tapping the picked
    radio again takes the answer back. */
function QuestionPage({
  question,
  selected,
  other,
  otherOn,
  onSelect,
  onOther,
  onOtherOn,
  onPointerPick,
  onOtherEnter,
}: {
  question: QuestionItem;
  selected: string[];
  other: string;
  otherOn: boolean;
  onSelect: (selected: string[]) => void;
  onOther: (text: string) => void;
  onOtherOn: (on: boolean) => void;
  onPointerPick: (value: string, cleared: boolean) => void;
  onOtherEnter: () => void;
}) {
  const multi = question.multiSelect === true;
  const pointerAt = useRef(Number.NEGATIVE_INFINITY);
  const otherField = useRef<HTMLDivElement>(null);
  const openOther = (on: boolean): void => {
    onOtherOn(on);
    // Picking Other means "I want to type", after any text kept from before.
    // preventScroll: the card is still growing, and the clipped pager would
    // scroll itself down to the field.
    if (on)
      requestAnimationFrame(() => {
        const input = otherField.current?.querySelector("input");
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(input.value.length, input.value.length);
      });
  };
  const items: readonly { label: string; value: string; description?: string | undefined }[] = [
    ...question.options.map((option) => ({ label: option.label, value: option.label, description: option.description })),
    { label: "Other", value: OTHER },
  ];
  const checkedValues = otherOn ? [...selected, OTHER] : selected;
  const row = (item: (typeof items)[number], control: ReactNode) => (
    <Field key={item.value} orientation="horizontal" data-option={item.value} className="question-card__option">
      {control}
      <FieldContent>
        <FieldLabel className="text-foreground">{item.label}</FieldLabel>
        <FieldDescription>{item.description}</FieldDescription>
      </FieldContent>
    </Field>
  );

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm/5 font-medium question-card__question">
        {question.question}
      </span>
      <div
        className="question-card__options"
        // Arrow keys move a radio group's pick by synthesizing clicks, and a
        // label forwards its click with detail 0 too — so a pointerdown marks a tap.
        onPointerDown={() => {
          pointerAt.current = performance.now();
        }}
        onClick={(event) => {
          // A tap on a radio or its label; the hidden input's own click stays inside the radio.
          if (multi || !(event.target instanceof Element)) return;
          const option = event.target.closest<HTMLElement>("[data-option]");
          if (option === null || event.target.closest('[role="radio"], label') === null) return;
          const value = option.dataset.option!;
          if (performance.now() - pointerAt.current > 1000) return;
          pointerAt.current = Number.NEGATIVE_INFINITY;
          // This render's state is from before the tap: was the tapped row already the pick?
          const cleared = value === OTHER ? otherOn : selected[0] === value;
          if (cleared) {
            if (value === OTHER) onOtherOn(false);
            else onSelect([]);
          }
          onPointerPick(value, cleared);
        }}
      >
        {multi ? (
          <div role="group" aria-label={question.header} className="flex flex-col">
            {items.map((item) =>
              row(
                item,
                <Checkbox
                  checked={checkedValues.includes(item.value)}
                  onCheckedChange={(on) => {
                    const next = on ? [...checkedValues, item.value] : checkedValues.filter((value) => value !== item.value);
                    onSelect(next.filter((value) => value !== OTHER));
                    if (next.includes(OTHER) !== otherOn) openOther(!otherOn);
                  }}
                />,
              ),
            )}
          </div>
        ) : (
          <RadioGroup
            aria-label={question.header}
            value={otherOn ? OTHER : (selected[0] ?? "")}
            onValueChange={(next: string) => {
              if (next === OTHER) {
                onSelect([]);
                openOther(true);
                return;
              }
              onSelect([next]);
              onOtherOn(false);
            }}
          >
            {items.map((item) => row(item, <RadioGroupItem value={item.value} />))}
          </RadioGroup>
        )}
      </div>
      {otherOn ? (
        <div
          ref={otherField}
          className="question-card__other"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onOtherEnter();
            }
          }}
        >
          <Field>
            <FieldLabel className="sr-only">Other answer</FieldLabel>
            <Input
              value={other}
              onChange={(event) => onOther(event.target.value)}
              placeholder="Your answer…"
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/** ←/→ page the card while focus is on its chrome — not in an option list,
    where the arrows move the pick, nor in a text field. */
function pagingKeys(index: number, go: (next: number) => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowRight") go(index + 1);
    else if (event.key === "ArrowLeft") go(index - 1);
    else return;
    event.preventDefault();
  };
}
