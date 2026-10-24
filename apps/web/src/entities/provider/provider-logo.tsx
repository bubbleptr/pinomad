/// <reference types="vite/client" />
import type { CSSProperties } from "react";

// Logos from @lobehub/icons-static-svg 1.98.0 (MIT, docs/licenses/lobehub-icons.md).
// Monochrome ones paint with currentColor, so they follow the theme.
const LOGOS = import.meta.glob<string>("./logos/*.svg", { query: "?raw", import: "default", eager: true });

/**
 * Provider id → logo file, first match wins; an entry also covers its
 * regional or plan variants (`zai-coding-cn`, `xiaomi-token-plan-sgp`).
 */
const LOGO_OF: readonly (readonly [id: string, logo: string])[] = [
  ["anthropic", "anthropic"],
  ["openai-codex", "codex-color"],
  ["openai", "openai"],
  ["github-copilot", "githubcopilot"],
  ["xai", "xai"],
  ["kimi-coding", "kimi-color"],
  ["meta", "meta-color"],
  ["openrouter", "openrouter"],
  ["google-vertex", "vertexai-color"],
  ["google", "gemini-color"],
  ["amazon-bedrock", "bedrock-color"],
  ["azure", "azure-color"],
  ["deepseek", "deepseek-color"],
  ["mistral", "mistral-color"],
  ["groq", "groq"],
  ["cerebras", "cerebras-color"],
  ["together", "together-color"],
  ["fireworks", "fireworks-color"],
  ["baseten", "baseten"],
  ["huggingface", "huggingface-color"],
  ["nvidia", "nvidia-color"],
  ["vercel-ai-gateway", "vercel"],
  ["cloudflare", "cloudflare-color"],
  ["zai", "zai"],
  ["moonshotai", "moonshot"],
  ["minimax", "minimax-color"],
  ["qwen-token-plan", "qwen-color"],
  ["xiaomi", "xiaomimimo"],
  ["ant-ling", "ling-color"],
  ["opencode", "opencode"],
  ["ollama", "ollama"],
  ["lmstudio", "lmstudio"],
];

const svgFor = (providerId: string): string | undefined => {
  const entry = LOGO_OF.find(([id]) => providerId === id || providerId.startsWith(`${id}-`));
  // The <title> would surface as a hover tooltip; the name is beside the logo anyway.
  return entry === undefined ? undefined : LOGOS[`./logos/${entry[1]}.svg`]?.replace(/<title>.*?<\/title>/, "");
};

/** Ollama's default port is the one tell a custom endpoint gives about what serves it. */
const OLLAMA_PORT = "11434";

const endpointPort = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).port;
  } catch {
    return undefined;
  }
};

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

/**
 * A provider's logo on a rounded tile, or its initials when there is none.
 * A custom endpoint passes its `baseUrl` and gets the Ollama logo on Ollama's
 * port. Decorative: the provider's name always sits beside it.
 */
export function ProviderLogo({
  providerId,
  name,
  baseUrl,
  size = 32,
}: {
  providerId: string;
  name: string;
  baseUrl?: string;
  size?: number;
}) {
  const svg =
    baseUrl === undefined ? svgFor(providerId) : endpointPort(baseUrl) === OLLAMA_PORT ? svgFor("ollama") : undefined;
  const style = { "--provider-logo-size": `${size}px` } as CSSProperties;
  if (svg === undefined) {
    return (
      <span className="provider-logo" data-initials="" style={style} aria-hidden="true">
        {initialsOf(name)}
      </span>
    );
  }
  return <span className="provider-logo" style={style} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
