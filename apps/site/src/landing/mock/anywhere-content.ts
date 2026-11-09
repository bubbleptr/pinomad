import type { Lang } from "@/lib/i18n.ts";

// The phone in "away from your desk": omarchy's "Currency in the bills API" from the
// hero, at three earlier moments. You send the task from the phone, answer the
// agent's questions, then read the diff. The back screen's list comes from the hero's
// own content, so the names agree. The iOS app's own words stay English in both
// languages, as in the hero.

/** The iOS transcript's pieces, which differ from the web client's. */
export type PhoneBlock =
  | { kind: "user"; text: string }
  /** The turn's work, folded into one line once it settles. */
  | { kind: "worked"; seconds: number; tools: number }
  | { kind: "text"; text: string }
  /** The live step at the bottom of a running turn. */
  | { kind: "trace"; label: string; since: number };

export type Option = { label: string; detail: string };

export type Question = { question: string; options: Option[] };

export type DiffLine = { kind: "meta" | "add" | "del" | "ctx"; text: string };

export type AnywhereContent = {
  /** Step one: the message as sent from the phone, and the run starting on it. */
  start: PhoneBlock[];
  /** Step two: the transcript behind the question card, and the card's questions. */
  ask: PhoneBlock[];
  questions: Question[];
  /** Step three: a file opened from the conversation's Changes. */
  file: { path: string; lines: DiffLine[] };
};

// Code reads the same in both languages. Lines stay within what a 402pt screen
// shows at 12pt monospace; the comment is the second answer, put to work.
const file = {
  path: "src/bills.ts",
  lines: [
    { kind: "meta", text: "@@ -1,8 +1,10 @@" },
    { kind: "ctx", text: ' import { db } from "./db.ts";' },
    { kind: "add", text: '+import { convert } from "./rates.ts";' },
    { kind: "ctx", text: " " },
    { kind: "ctx", text: " export type Bill = {" },
    { kind: "ctx", text: "   id: string;" },
    { kind: "ctx", text: "   amount: number;" },
    { kind: "add", text: "+  currency: string;" },
    { kind: "ctx", text: "   paidAt: Date;" },
    { kind: "ctx", text: " };" },
    { kind: "meta", text: "@@ -18,8 +20,17 @@" },
    { kind: "ctx", text: " export async function listBills(trip: Trip) {" },
    { kind: "ctx", text: "   const bills = await db.bills.byTrip(trip.id);" },
    { kind: "del", text: "-  return bills.map((bill) => ({" },
    { kind: "del", text: "-    ...bill," },
    { kind: "del", text: "-    amount: formatUsd(bill.amount)," },
    { kind: "del", text: "-  }));" },
    { kind: "add", text: "+  return Promise.all(" },
    { kind: "add", text: "+    bills.map(async (bill) => ({" },
    { kind: "add", text: "+      ...bill," },
    { kind: "add", text: "+      // The rate on the day it was paid, so" },
    { kind: "add", text: "+      // totals don't move after the trip." },
    { kind: "add", text: "+      home: await convert(bill, trip.currency)," },
    { kind: "add", text: "+    }))," },
    { kind: "add", text: "+  );" },
    { kind: "ctx", text: " }" },
  ],
} satisfies AnywhereContent["file"];

const en: AnywhereContent = {
  start: [
    {
      kind: "user",
      text: "Add a currency to bills, fill it in for the old ones, and have the API return each amount in its own currency and in the trip's home currency.",
    },
    { kind: "trace", label: "Running bash", since: 6 },
  ],
  ask: [
    {
      kind: "user",
      text: "Add a currency to bills, fill it in for the old ones, and have the API return each amount in its own currency and in the trip's home currency.",
    },
    { kind: "worked", seconds: 41, tools: 6 },
    {
      kind: "text",
      text: "1.2 million bills have no currency yet, and every ledger already has one. Two things to settle before I write the migration.",
    },
  ],
  questions: [
    {
      question: "Old bills have no currency. What should the backfill put in?",
      options: [
        { label: "Their ledger's currency", detail: "Each ledger picked one when it was made" },
        { label: "CNY for all of them", detail: "Simple, but bills from trips abroad come out wrong" },
      ],
    },
    {
      question: "Which day's rate converts a bill?",
      options: [
        { label: "The day it was paid", detail: "Totals don't move after the trip" },
        { label: "The day you settle up", detail: "Totals change until everyone has paid" },
      ],
    },
  ],
  file,
};

const zhTask = "账单加上币种，旧账单也补上；接口返回每笔金额的原币种金额和按旅行主币种换算后的金额。";

export const anywhereContent: Record<Lang, AnywhereContent> = {
  en,
  zh: {
    start: [
      { kind: "user", text: zhTask },
      { kind: "trace", label: "Running bash", since: 6 },
    ],
    ask: [
      { kind: "user", text: zhTask },
      { kind: "worked", seconds: 41, tools: 6 },
      { kind: "text", text: "有 120 万条账单还没有币种，而每个账本都已经选过币种。写迁移之前有两件事要你定。" },
    ],
    questions: [
      {
        question: "旧账单没有币种，回填时填什么？",
        options: [
          { label: "按所属账本的币种", detail: "每个账本建的时候都选过币种" },
          { label: "全部填 CNY", detail: "简单，但出国旅行记的账会算错" },
        ],
      },
      {
        question: "换算用哪天的汇率？",
        options: [
          { label: "记账当天", detail: "旅行结束后总额不再变" },
          { label: "结算当天", detail: "所有人付清之前总额都会变" },
        ],
      },
    ],
    file,
  },
};
