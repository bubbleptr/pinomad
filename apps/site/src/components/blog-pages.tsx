import { Link, notFound } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Suspense } from "react";
import { loadBlogPost, type loadBlogIndex } from "@/lib/content-data.ts";
import { formatDate, type Lang } from "@/lib/i18n.ts";
import { blog, blogPosts } from "@/lib/source.ts";
import { homeLayout, Shell } from "./shell.tsx";

const copy = {
  en: { title: "Blog", lead: "Releases, design notes, and what we're working on." },
  zh: { title: "博客", lead: "版本发布、设计记录和正在做的事。" },
} as const;

type BlogIndex = Awaited<ReturnType<typeof loadBlogIndex>>;

export function BlogIndexPage({ lang, posts }: { lang: Lang; posts: BlogIndex }) {
  return (
    <Shell lang={lang}>
      <HomeLayout {...homeLayout}>
        <div className="mx-auto w-full max-w-3xl px-4 py-12">
          <h1 className="text-3xl font-semibold">{copy[lang].title}</h1>
          <p className="mt-2 text-fd-muted-foreground">{copy[lang].lead}</p>
          <ul className="mt-10 flex flex-col gap-8">
            {posts.map((post) => (
              <li key={post.url}>
                <Link to={post.url} className="group block">
                  <time className="text-sm text-fd-muted-foreground" dateTime={post.date}>
                    {formatDate(lang, post.date)}
                  </time>
                  <h2 className="mt-1 text-xl font-medium group-hover:underline">{post.title}</h2>
                  <p className="mt-1 text-fd-muted-foreground">{post.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </HomeLayout>
    </Shell>
  );
}

export async function blogPostLoader(lang: Lang, slug: string) {
  // Only posts that exist were prerendered (see docsLoader).
  if (!blog.getPage([slug], lang)) throw notFound();
  const data = await loadBlogPost({ data: { lang, slug } });
  await blogPosts.get(data.path)?.preload();
  return data;
}

export function BlogPostPage({ lang, path }: { lang: Lang; path: string }) {
  const post = blogPosts.get(path);
  if (!post) throw new Error(`unknown blog post: ${path}`);
  const MDX = post.body;
  return (
    <Shell lang={lang}>
      <HomeLayout {...homeLayout}>
        <article className="mx-auto w-full max-w-3xl px-4 py-12">
          <time className="text-sm text-fd-muted-foreground" dateTime={post.date}>
            {formatDate(lang, post.date)}
          </time>
          <h1 className="mt-1 text-3xl font-semibold">{post.title}</h1>
          <p className="mt-2 text-fd-muted-foreground">{post.description}</p>
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
