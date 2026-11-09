import type { Lang } from "@/lib/i18n.ts";
import type { Run } from "./runs.ts";

// What the hero's product windows show: two machines in the sidebar, their projects
// and conversations, and what each conversation holds. The app's own words (New chat,
// View, Running…) stay English in both languages, as in the real client; the
// conversations are written per language.

export type Inline = string | { code: string };

export type Block =
  | { kind: "user"; text: string }
  | { kind: "text"; parts: Inline[] }
  | { kind: "tools"; summary: string; added?: number; removed?: number; seconds?: number }
  | { kind: "agents"; runs: Run[] };

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
};

const url = "app.pinomad.si";

const runs = {
  fold: { agent: "worker", model: "claude", modelId: "anthropic/claude-sonnet-5-5", since: 64, finishesIn: 150 },
  vietnamese: { agent: "worker", model: "deepseek", modelId: "deepseek/deepseek-v4.1-flash", since: 43, finishesIn: 5 },
  collisions: { agent: "critic", model: "openai", modelId: "openai/gpt-5.5", since: 31, finishesIn: 200 },
  tests: { agent: "worker", model: "claude", modelId: "anthropic/claude-sonnet-5-5", since: 96, done: true },
  restore: { agent: "worker", model: "qwen", modelId: "ollama/qwen3-coder:30b", since: 252, finishesIn: 240 },
} as const;

export const mockContent: Record<Lang, MockContent> = {
  en: {
    url,
    defaultChat: "fold",
    restarted: "omarchy restarted. Its run picked up where it left off.",
    machines: [
      {
        name: "macbook-pro",
        projects: [
          {
            name: "slugkit",
            chats: [
              {
                id: "fold",
                title: "Fold accented letters",
                running: true,
                blocks: [
                  {
                    kind: "user",
                    text: "@planner Slugs drop accented letters: “Ærøskøbing” comes out as “rskbing”. Plan the fix and split it up.",
                  },
                  { kind: "tools", summary: "Read 3 files", seconds: 12 },
                  {
                    kind: "text",
                    parts: [
                      { code: "slugify()" },
                      " strips everything outside ASCII before it lowercases. The fix is to fold letters to ASCII first, then make sure no two titles end up with the same slug. Handing it out:",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [
                      { ...runs.fold, title: "Add the fold map", activity: "edit src/slug.js" },
                      { ...runs.vietnamese, title: "Cover Vietnamese letters", activity: "read test/slug.test.js" },
                      { ...runs.collisions, title: "Look for slug collisions", activity: "bash bun test" },
                    ],
                  },
                ],
              },
              {
                id: "docs",
                title: "Docs and tests",
                blocks: [
                  { kind: "user", text: "Document the folding rules in the README and add a test for every example." },
                  { kind: "agents", runs: [{ ...runs.tests, title: "Table-driven tests" }] },
                  { kind: "tools", summary: "Edited 2 files, ran 1 command", added: 38, removed: 2, seconds: 74 },
                  {
                    kind: "text",
                    parts: [
                      "Done. ",
                      { code: "README.md" },
                      " lists the map with one example per letter, and ",
                      { code: "test/slug.test.js" },
                      " checks each of them. All 14 tests pass.",
                    ],
                  },
                ],
              },
              {
                id: "cyrillic",
                title: "Non-Latin titles",
                blocks: [
                  { kind: "user", text: "Should Cyrillic and Greek titles go through the same map?" },
                  {
                    kind: "text",
                    parts: [
                      "No. Folding only drops marks from Latin letters; ",
                      { code: "Москва" },
                      " needs transliteration to become ",
                      { code: "moskva" },
                      ". That is a table per script, so I'd keep it out of the fold map and add it as its own step.",
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
            name: "homelab",
            chats: [
              {
                id: "postgres",
                title: "Upgrade Postgres to 18",
                running: true,
                blocks: [
                  {
                    kind: "user",
                    text: "Move the Postgres container to 18 and migrate the data. Keep the old volume until the new one checks out.",
                  },
                  { kind: "tools", summary: "Read 2 files, ran 4 commands", seconds: 95 },
                  {
                    kind: "text",
                    parts: ["Dumped the database (2.1 GB) and started 18 on a fresh volume. ", { code: "@worker" }, " is restoring it:"],
                  },
                  { kind: "agents", runs: [{ ...runs.restore, title: "Restore and verify", activity: "bash pg_restore -j 4" }] },
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
    defaultChat: "fold",
    restarted: "omarchy 重启了，运行从断点接着跑。",
    machines: [
      {
        name: "macbook-pro",
        projects: [
          {
            name: "slugkit",
            chats: [
              {
                id: "fold",
                title: "折叠重音字母",
                running: true,
                blocks: [
                  { kind: "user", text: "@planner slug 会丢掉带重音的字母：“Ærøskøbing” 变成了 “rskbing”。定个方案，拆开分给大家。" },
                  { kind: "tools", summary: "Read 3 files", seconds: 12 },
                  {
                    kind: "text",
                    parts: [
                      { code: "slugify()" },
                      " 在转小写之前把 ASCII 以外的字符全删了。修法是先把字母折叠成 ASCII，再确认不会有两个标题撞成同一个 slug。分给：",
                    ],
                  },
                  {
                    kind: "agents",
                    runs: [
                      { ...runs.fold, title: "加折叠映射表", activity: "edit src/slug.js" },
                      { ...runs.vietnamese, title: "补越南语字母", activity: "read test/slug.test.js" },
                      { ...runs.collisions, title: "检查 slug 冲突", activity: "bash bun test" },
                    ],
                  },
                ],
              },
              {
                id: "docs",
                title: "补文档和测试",
                blocks: [
                  { kind: "user", text: "在 README 里写清楚折叠规则，每个例子补一个测试。" },
                  { kind: "agents", runs: [{ ...runs.tests, title: "表驱动测试" }] },
                  { kind: "tools", summary: "Edited 2 files, ran 1 command", added: 38, removed: 2, seconds: 74 },
                  {
                    kind: "text",
                    parts: [
                      "好了。",
                      { code: "README.md" },
                      " 列出了映射表，每个字母一个例子；",
                      { code: "test/slug.test.js" },
                      " 逐个检查。14 个测试全部通过。",
                    ],
                  },
                ],
              },
              {
                id: "cyrillic",
                title: "非拉丁标题",
                blocks: [
                  { kind: "user", text: "西里尔字母和希腊字母的标题也走同一张映射表吗？" },
                  {
                    kind: "text",
                    parts: [
                      "不走。折叠只是去掉拉丁字母上的符号；",
                      { code: "Москва" },
                      " 要靠音译才能变成 ",
                      { code: "moskva" },
                      "。那是每种文字一张表，建议不放进折叠映射表，单独加一步。",
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
            name: "homelab",
            chats: [
              {
                id: "postgres",
                title: "Postgres 升到 18",
                running: true,
                blocks: [
                  { kind: "user", text: "把 Postgres 容器升到 18，迁移数据。新卷验证通过之前别删旧卷。" },
                  { kind: "tools", summary: "Read 2 files, ran 4 commands", seconds: 95 },
                  {
                    kind: "text",
                    parts: ["数据库已经导出（2.1 GB），18 在新卷上起来了。", { code: "@worker" }, " 正在恢复："],
                  },
                  { kind: "agents", runs: [{ ...runs.restore, title: "恢复并校验", activity: "bash pg_restore -j 4" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
