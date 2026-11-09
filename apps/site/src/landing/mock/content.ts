import type { Lang } from "@/lib/i18n.ts";
import type { Run } from "./runs.ts";

// What the hero's product windows show: two machines in the sidebar, their projects
// and conversations, and what each conversation holds. The story is one feature of a
// cross-platform app split by machine: the iOS and web clients on the Mac (iOS only
// builds there), the API and its database on the Linux box at home. The app's own
// words (New chat, View, Running…) stay English in both languages, as in the real
// client; the conversations are written per language.

export type Inline = string | { code: string };

export type Block =
  | { kind: "user"; text: string }
  | { kind: "text"; parts: Inline[] }
  | { kind: "tools"; summary: string; added?: number; removed?: number; seconds?: number }
  | { kind: "agents"; runs: Run[] }
  /** The live step at the bottom of a running turn: a shimmering label and its clock. */
  | { kind: "trace"; label: string; since: number };

export type Chat = { id: string; title: string; running?: boolean; blocks: Block[] };

export type Machine = {
  name: string;
  /** Goes offline for a moment and comes back with its run still going. */
  restarts?: boolean;
  projects: { name: string; chats: Chat[] }[];
};

export type MockContent = {
  machines: Machine[];
  /** The conversation open on load, the one both windows show. */
  defaultChat: string;
  /** The browser window's address. */
  url: string;
  /** The note beside the restarting machine. */
  restarted: string;
  /** What the browser in front shows: one of the default conversation's subagents, opened. */
  aside: { agent: string; model: Run["model"]; title: string; blocks: Block[] };
};

const url = "app.pinomad.si";

const runs = {
  ios: { agent: "worker", model: "claude", modelId: "anthropic/claude-sonnet-5-5", since: 64, finishesIn: 150 },
  web: { agent: "worker", model: "deepseek", modelId: "deepseek/deepseek-v4.1-flash", since: 43, finishesIn: 5 },
  formats: { agent: "critic", model: "openai", modelId: "openai/gpt-5.5", since: 31, finishesIn: 200 },
  tests: { agent: "worker", model: "claude", modelId: "anthropic/claude-sonnet-5-5", since: 96, done: true },
  backfill: { agent: "worker", model: "qwen", modelId: "ollama/qwen3-coder:30b", since: 252, finishesIn: 240 },
} as const;

export const mockContent: Record<Lang, MockContent> = {
  en: {
    url,
    defaultChat: "currency",
    restarted: "omarchy restarted. Its run picked up where it left off.",
    aside: {
      agent: "critic",
      model: "openai",
      title: "Compare formats",
      blocks: [
        {
          kind: "user",
          text: "Compare how iOS and the web format all 30 currencies.",
        },
        { kind: "tools", summary: "Read 2 files, ran 1 command", seconds: 18 },
        {
          kind: "text",
          parts: [
            "Found one: yen and won have no decimals, but the web shows ",
            { code: "¥1,200.00" },
            " where iOS shows ",
            { code: "¥1,200" },
            ". Both should take the decimals from the currency. Checking the rest:",
          ],
        },
        { kind: "trace", label: "Running bash…", since: 14 },
      ],
    },
    machines: [
      {
        name: "macbook-pro",
        projects: [
          {
            name: "splitbill",
            chats: [
              {
                id: "currency",
                title: "Currencies in the apps",
                running: true,
                blocks: [
                  {
                    kind: "user",
                    text: "@planner Bills need a currency: show it next to every amount on iOS and the web, and settle up in the trip's home currency. The API side is being done on omarchy.",
                  },
                  { kind: "tools", summary: "Read 4 files", seconds: 12 },
                  {
                    kind: "text",
                    parts: [
                      { code: "Bill.amount" },
                      " is a bare number, and both clients print it as dollars. The API will send a currency code with each bill, so each client has to show it and format the amount for that currency. Handing it out:",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [
                      { ...runs.ios, title: "Currency on iOS", activity: "edit ios/BillRow.swift" },
                      { ...runs.web, title: "Currency on the web", activity: "edit web/src/BillRow.tsx" },
                      { ...runs.formats, title: "Compare formats", activity: "bash bun test" },
                    ],
                  },
                  { kind: "trace", label: "Running subagent…", since: 64 },
                ],
              },
              {
                id: "tests",
                title: "Settle-up tests",
                blocks: [
                  { kind: "user", text: "Add a settle-up test for every currency we support, including the ones without decimals." },
                  { kind: "agents", runs: [{ ...runs.tests, title: "One trip per currency" }] },
                  { kind: "tools", summary: "Edited 2 files, ran 1 command", added: 38, removed: 2, seconds: 74 },
                  {
                    kind: "text",
                    parts: [
                      "Done. ",
                      { code: "settle.test.ts" },
                      " settles one trip in each currency, yen and won included. All 32 tests pass.",
                    ],
                  },
                ],
              },
              {
                id: "android",
                title: "Android app",
                blocks: [
                  { kind: "user", text: "When we build the Android app, should it share code with iOS or be written natively?" },
                  {
                    kind: "text",
                    parts: [
                      "Natively, for now. Conversion and rounding already live on the server, so an Android client only formats amounts and calls ",
                      { code: "/bills" },
                      ". Shared code pays off once all three clients need the same logic on the device.",
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        name: "omarchy",
        restarts: true,
        projects: [
          {
            name: "splitbill-api",
            chats: [
              {
                id: "api",
                title: "Currency in the bills API",
                running: true,
                blocks: [
                  {
                    kind: "user",
                    text: "Add a currency to bills, fill it in for the old ones, and have the API return each amount in its own currency and in the trip's home currency.",
                  },
                  { kind: "tools", summary: "Read 4 files, ran 3 commands", seconds: 95 },
                  {
                    kind: "text",
                    parts: [
                      "Added the column in ",
                      { code: "0042_bill_currency.sql" },
                      ", and the API returns both amounts. 1.2 million old bills still need a currency; ",
                      { code: "@worker" },
                      " is filling them in batches:",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [{ ...runs.backfill, title: "Backfill old bills", activity: "bash bun run backfill --batch 500" }],
                  },
                  { kind: "trace", label: "Running subagent…", since: 253 },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  zh: {
    url,
    defaultChat: "currency",
    restarted: "omarchy 重启了，运行接着跑。",
    aside: {
      agent: "critic",
      model: "openai",
      title: "检查金额格式",
      blocks: [
        { kind: "user", text: "确认同一笔金额在 iOS 和 Web 上显示得一样，我们支持的 30 种货币都要查。" },
        { kind: "tools", summary: "Read 2 files, ran 1 command", seconds: 18 },
        {
          kind: "text",
          parts: [
            "找到一处：日元和韩元没有小数位。Web 显示成 ",
            { code: "¥1,200.00" },
            "，iOS 是 ",
            { code: "¥1,200" },
            "。两端都应该按货币取小数位，不要一律写死两位。继续查剩下的：",
          ],
        },
        { kind: "trace", label: "Running bash…", since: 14 },
      ],
    },
    machines: [
      {
        name: "macbook-pro",
        projects: [
          {
            name: "splitbill",
            chats: [
              {
                id: "currency",
                title: "iOS 和 Web 支持多币种",
                running: true,
                blocks: [
                  {
                    kind: "user",
                    text: "@planner 账单要支持多币种：iOS 和 Web 上每笔金额旁边显示币种，结算时按这次旅行的主币种算。服务端在 omarchy 上做。",
                  },
                  { kind: "tools", summary: "Read 4 files", seconds: 12 },
                  {
                    kind: "text",
                    parts: [
                      { code: "Bill.amount" },
                      " 现在只是一个数字，两端都当成美元显示。接口会给每笔账单带上币种代码，客户端要把币种显示出来，并按这种货币的格式显示金额。分给：",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [
                      { ...runs.ios, title: "iOS 显示币种", activity: "edit ios/BillRow.swift" },
                      { ...runs.web, title: "Web 显示币种", activity: "edit web/src/BillRow.tsx" },
                      { ...runs.formats, title: "检查金额格式", activity: "bash bun test" },
                    ],
                  },
                  { kind: "trace", label: "Running subagent…", since: 64 },
                ],
              },
              {
                id: "tests",
                title: "补结算测试",
                blocks: [
                  { kind: "user", text: "每种支持的货币都补一个结算测试，没有小数位的也要有。" },
                  { kind: "agents", runs: [{ ...runs.tests, title: "每种货币一次旅行" }] },
                  { kind: "tools", summary: "Edited 2 files, ran 1 command", added: 38, removed: 2, seconds: 74 },
                  {
                    kind: "text",
                    parts: ["好了。", { code: "settle.test.ts" }, " 每种货币结算一次旅行，日元和韩元都在里面。32 个测试全部通过。"],
                  },
                ],
              },
              {
                id: "android",
                title: "安卓版怎么写",
                blocks: [
                  { kind: "user", text: "以后做安卓版，是和 iOS 共享代码，还是直接写原生？" },
                  {
                    kind: "text",
                    parts: [
                      "先写原生。换算和取整已经在服务端，安卓客户端只负责显示金额、调 ",
                      { code: "/bills" },
                      "。等三个端都要在设备上跑同一套逻辑时，共享代码才划算。",
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        name: "omarchy",
        restarts: true,
        projects: [
          {
            name: "splitbill-api",
            chats: [
              {
                id: "api",
                title: "账单接口加币种",
                running: true,
                blocks: [
                  { kind: "user", text: "账单加上币种，旧账单也补上；接口返回每笔金额的原币种金额和按旅行主币种换算后的金额。" },
                  { kind: "tools", summary: "Read 4 files, ran 3 commands", seconds: 95 },
                  {
                    kind: "text",
                    parts: [
                      "已经在 ",
                      { code: "0042_bill_currency.sql" },
                      " 里加了这一列，接口也会返回两种金额。还有 120 万条旧账单没有币种，",
                      { code: "@worker" },
                      " 正在分批回填：",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [{ ...runs.backfill, title: "回填旧账单", activity: "bash bun run backfill --batch 500" }],
                  },
                  { kind: "trace", label: "Running subagent…", since: 253 },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
