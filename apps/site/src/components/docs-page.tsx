import { notFound } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { loadDocsPage } from "@/lib/content-data.ts";
import type { Lang } from "@/lib/i18n.ts";
import { docs, source } from "@/lib/source.ts";
import { baseOptions, Shell } from "./shell.tsx";

type DocsData = Awaited<ReturnType<typeof loadDocsPage>>;

export async function docsLoader(lang: Lang, splat: string | undefined): Promise<DocsData> {
  const slugs = (splat ?? "").split("/").filter(Boolean);
  // Only pages that exist were prerendered; asking for any other one would
  // fetch a data file that isn't there.
  if (!source.getPage(slugs, lang)) throw notFound();
  const data = await loadDocsPage({ data: { lang, slugs } });
  // Load the MDX chunk before render so the prerendered HTML has the content.
  await docs.getPage(data.path)?.preload();
  return data;
}

function Content({ path }: { path: string }) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`unknown docs page: ${path}`);
  const { toc } = use(page.load());
  const MDX = page.body;
  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <MDX components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function DocsRoutePage({ lang, data }: { lang: Lang; data: DocsData }) {
  const { path, pageTree } = useFumadocsLoader(data);
  return (
    <Shell lang={lang}>
      <DocsLayout {...baseOptions(lang)} tree={pageTree}>
        <Suspense>
          <Content path={path} />
        </Suspense>
      </DocsLayout>
    </Shell>
  );
}
