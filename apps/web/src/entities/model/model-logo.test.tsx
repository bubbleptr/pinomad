import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelLogo, modelLogoFile } from "./model-logo.tsx";

describe("modelLogoFile", () => {
  it("names the model's maker whoever serves it", () => {
    expect(modelLogoFile({ provider: "github-copilot", modelId: "claude-sonnet-4.5" })).toBe("claude-color");
    expect(modelLogoFile({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-1-20250805-v1:0" })).toBe(
      "claude-color",
    );
    expect(modelLogoFile({ provider: "openrouter", modelId: "moonshotai/kimi-k2" })).toBe("kimi-color");
  });

  it("tells Google's Gemma from Gemini", () => {
    expect(modelLogoFile({ provider: "google", modelId: "gemma-3-27b-it" })).toBe("gemma-color");
    expect(modelLogoFile({ provider: "openrouter", modelId: "google/gemini-2.5-pro" })).toBe("gemini-color");
  });

  it("reads o-series ids as OpenAI without catching other o-words", () => {
    expect(modelLogoFile({ provider: "github-copilot", modelId: "o4-mini" })).toBe("openai");
    expect(modelLogoFile({ provider: "openrouter", modelId: "openrouter/optimus-alpha" })).toBe("openrouter");
  });

  it("credits the leftmost maker in a fine-tune's id", () => {
    expect(modelLogoFile({ provider: "groq", modelId: "deepseek-r1-distill-llama-70b" })).toBe("deepseek-color");
    expect(modelLogoFile({ provider: "nvidia", modelId: "nvidia/llama-3.1-nemotron-70b-instruct" })).toBe("nvidia-color");
  });

  it("falls back to the provider's logo, then to none", () => {
    expect(modelLogoFile({ provider: "kimi-coding", modelId: "k3-256k" })).toBe("kimi-color");
    expect(modelLogoFile({ provider: "opencode", modelId: "big-pickle" })).toBe("opencode");
    expect(modelLogoFile({ provider: "custom-lab", modelId: "house-model" })).toBeUndefined();
  });
});

describe("ModelLogo", () => {
  it("keeps an empty slot only when asked to, so list labels stay aligned", () => {
    const unknown = { provider: "custom-lab", modelId: "house-model" };
    expect(render(<ModelLogo model={unknown} />).container).toBeEmptyDOMElement();
    expect(render(<ModelLogo model={unknown} reserve />).container.querySelector(".model-logo")).toBeInTheDocument();
  });
});
