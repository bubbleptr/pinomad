import defaultMdxComponents from "fumadocs-ui/mdx";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { loadChangelog } from "@/lib/content-data.ts";
import { formatDate, type Lang } from "@/lib/i18n.ts";
import { releases } from "@/lib/source.ts";
import { baseOptions, Shell } from "./shell.tsx";

const copy = {
  en: { title: "Changelog", lead: "What changed in each release.", release: "Release on GitHub" },
  zh: { title: "更新日志", lead: "每个版本改了什么。", release: "GitHub 上的发布" },
} as const;

type Entries = Awaited<ReturnType<typeof loadChangelog>>;

export async function preloadChangelog(entries: Entries) {
  await Promise.all(entries.map((entry) => releases.get(entry.path)?.preload()));
}

function Release({ lang, entry }: { lang: Lang; entry: Entries[number] }) {
  const release = releases.get(entry.path);
  if (!release) throw new Error(`unknown release notes: ${entry.path}`);
  const MDX = release.body;
  return (
    <article id={entry.version} className="grid gap-x-10 gap-y-2 border-t py-10 md:grid-cols-[10rem_1fr]">
      <header className="md:sticky md:top-20 md:self-start">
        <a href={`#${entry.version}`} className="font-mono text-sm font-medium">
          {entry.version}
        </a>
        <time className="block text-sm text-fd-muted-foreground" dateTime={entry.date}>
          {formatDate(lang, entry.date)}
        </time>
      </header>
      <div>
        <h2 className="text-xl font-semibold">{entry.title}</h2>
        <div className="prose mt-4">
          <MDX components={defaultMdxComponents} />
        </div>
        <a
          className="mt-4 inline-block text-sm text-fd-muted-foreground hover:text-fd-foreground"
          href={`https://github.com/bubbleptr/pinomad/releases/tag/${entry.version}`}
        >
          {copy[lang].release} →
        </a>
      </div>
    </article>
  );
}

export function ChangelogPage({ lang, entries }: { lang: Lang; entries: Entries }) {
  return (
    <Shell lang={lang}>
      <HomeLayout {...baseOptions(lang)}>
        <div className="mx-auto w-full max-w-4xl px-4 py-12">
          <h1 className="text-3xl font-semibold">{copy[lang].title}</h1>
          <p className="mt-2 mb-10 text-fd-muted-foreground">{copy[lang].lead}</p>
          {entries.map((entry) => (
            <Release key={entry.path} lang={lang} entry={entry} />
          ))}
        </div>
      </HomeLayout>
    </Shell>
  );
}
