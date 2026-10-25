import type { CSSProperties } from "react";
import type { ModelRef } from "@earendil-works/pi-durable";
import { logoSvg, providerLogoFile } from "../provider/provider-logo.tsx";

/**
 * Model family → logo file, tested against each token of the lowercased id.
 * Family names, plus a vendor prefix only where all its models share one logo:
 * no `google`, since `google/gemma-3` has to reach Gemma. Short names (`o3`,
 * `hy4`, `ring`) match the whole token so they don't catch longer words.
 */
const MAKER_OF: readonly (readonly [pattern: RegExp, logo: string])[] = [
  [/^claude/, "claude-color"],
  [/^(gpt|chatgpt|codex)|^o\d$/, "openai"],
  [/^gemini/, "gemini-color"],
  [/gemma/, "gemma-color"],
  [/^grok/, "grok"],
  [/^(qwen|qwq|qvq)/, "qwen-color"],
  [/^deepseek/, "deepseek-color"],
  [/^(kimi|moonshot)/, "kimi-color"],
  [/^(glm|chatglm)/, "zai"],
  [/^minimax/, "minimax-color"],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)/, "mistral-color"],
  [/^llama|^muse$/, "meta-color"],
  [/^(mimo|xiaomimimo)/, "xiaomimimo"],
  [/^(nvidia|nemotron)/, "nvidia-color"],
  [/^nova$/, "nova-color"],
  [/^(command|c4ai|aya|cohere)$/, "cohere-color"],
  [/^(seed|doubao|bytedance)/, "bytedance-color"],
  [/^hunyuan|^hy\d$/, "hunyuan-color"],
  [/^(step\d*|stepfun)$/, "stepfun-color"],
  [/^longcat/, "longcat-color"],
  [/^(ling|ring)$/, "ling-color"],
  [/^(phi\d*|mai)$/, "microsoft-color"],
  [/^granite/, "ibm"],
  [/^solar/, "upstage-color"],
  [/^mercury$/, "inception"],
  [/^lfm/, "liquid"],
  [/^laguna$/, "poolside-color"],
  [/^trinity$/, "arcee-color"],
  [/^kat$/, "kwaipilot-color"],
  [/^(sakana|fugu|namazu)$/, "sakana-color"],
  [/^reka$/, "reka"],
];

/**
 * The logo for a model: its maker's, found in the id whoever serves it
 * (`us.anthropic.claude-…` on Bedrock is Claude), else its provider's. The
 * leftmost family wins, so a fine-tune reads as its maker's
 * (`deepseek-r1-distill-llama` is DeepSeek).
 */
export const modelLogoFile = (model: ModelRef): string | undefined => {
  for (const token of model.modelId.toLowerCase().split(/[^a-z0-9]+/)) {
    const logo = MAKER_OF.find(([pattern]) => pattern.test(token))?.[1];
    if (logo !== undefined) return logo;
  }
  return providerLogoFile(model.provider);
};

/**
 * A model's logo as a bare glyph sized to sit beside its name. Decorative:
 * the name is always beside it. With no logo it renders nothing, or an
 * empty slot of the same size when `reserve` keeps a list's labels aligned.
 */
export function ModelLogo({ model, size = 16, reserve = false }: { model: ModelRef; size?: number; reserve?: boolean }) {
  const file = modelLogoFile(model);
  const svg = file === undefined ? undefined : logoSvg(file);
  if (svg === undefined && !reserve) return null;
  const style = { "--model-logo-size": `${size}px` } as CSSProperties;
  return (
    <span
      className="model-logo"
      style={style}
      aria-hidden="true"
      {...(svg === undefined ? {} : { dangerouslySetInnerHTML: { __html: svg } })}
    />
  );
}
