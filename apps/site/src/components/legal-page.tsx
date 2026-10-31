import { notFound } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Suspense } from "react";
import { loadLegalPage, type LegalSlug } from "@/lib/content-data.ts";
import { formatDate, type Lang } from "@/lib/i18n.ts";
import { legal, legalPages } from "@/lib/source.ts";
import { homeLayout, Shell } from "./shell.tsx";

const effective = { en: "Effective ", zh: "生效日期：" } as const;

export async function legalLoader(lang: Lang, slug: LegalSlug) {
  if (!legal.getPage([slug], lang)) throw notFound();
  const data = await loadLegalPage({ data: { lang, slug } });
  await legalPages.get(data.path)?.preload();
  return data;
}

/** The privacy policy or the terms: a plain article like a blog post, dated by when it took effect. */
export function LegalPage({ lang, path }: { lang: Lang; path: string }) {
  const page = legalPages.get(path);
  if (!page) throw new Error(`unknown legal page: ${path}`);
  const MDX = page.body;
  return (
    <Shell lang={lang}>
      <HomeLayout {...homeLayout}>
        <article className="mx-auto w-full max-w-3xl px-4 py-12">
          <h1 className="text-3xl font-semibold">{page.title}</h1>
          <p className="mt-2 text-sm text-fd-muted-foreground">
            {effective[lang]}
            <time dateTime={page.date}>{formatDate(lang, page.date)}</time>
          </p>
          <div className="prose mt-10">
            <Suspense>
              <MDX components={defaultMdxComponents} />
            </Suspense>
          </div>
        </article>
      </HomeLayout>
    </Shell>
  );
}
