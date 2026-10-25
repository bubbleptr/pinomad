import { loader } from "fumadocs-core/source";
import { defineCollections, defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";
import { i18n } from "./i18n.ts";

export const docs = defineDocs({
  dir: "content/docs",
  docs: { async: true },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
  i18n,
});

export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  async: true,
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.iso.date(),
  }),
});

export const blog = loader({
  source: blogPosts.toFumadocsSource(),
  baseUrl: "/blog",
  i18n,
});
