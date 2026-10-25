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

// One file per release (`v0.7.0.mdx`, `v0.7.0.zh.mdx`), newest shown first.
export const releases = defineCollections({
  type: "doc",
  dir: "content/changelog",
  async: true,
  schema: z.object({
    title: z.string(),
    version: z.string(),
    date: z.iso.date(),
  }),
});

export const changelog = loader({
  source: releases.toFumadocsSource(),
  baseUrl: "/changelog",
  i18n,
});
