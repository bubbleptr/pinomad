import { describe, expect, it } from "vitest";
import { agentNameProblem, agentRoleProblem, MAX_AGENT_DESCRIPTION } from "../src/agents.ts";

const role = (overrides: object = {}) => ({
  name: "reviewer",
  description: "Reviews code changes",
  prompt: "Look for mistakes.",
  ...overrides,
});

describe("agentRoleProblem", () => {
  it("accepts a minimal and a fully pinned role", () => {
    expect(agentRoleProblem(role())).toBeUndefined();
    expect(agentRoleProblem(role({ model: "anthropic/claude-opus-4", thinkingLevel: "high" }))).toBeUndefined();
    expect(agentRoleProblem(role({ prompt: "" }))).toBeUndefined();
  });

  it.each([
    ["uppercase", "Reviewer"],
    ["leading hyphen", "-reviewer"],
    ["trailing hyphen", "reviewer-"],
    ["underscore", "code_reviewer"],
    ["over 32 chars", "a".repeat(33)],
    ["empty", ""],
    ["spaces", "code reviewer"],
  ])("rejects a name with %s", (_what, name) => {
    expect(agentRoleProblem(role({ name }))).toContain("lowercase letters, digits and hyphens");
  });

  it("accepts names with digits and inner hyphens at the length cap", () => {
    expect(agentRoleProblem(role({ name: "code-reviewer-2" }))).toBeUndefined();
    expect(agentRoleProblem(role({ name: "a".repeat(32) }))).toBeUndefined();
  });

  it("rejects an empty and an over-long description", () => {
    expect(agentRoleProblem(role({ description: "   " }))).toBe("description is required");
    expect(agentRoleProblem(role({ description: "x".repeat(MAX_AGENT_DESCRIPTION + 1) }))).toContain("description is too long");
    expect(agentRoleProblem(role({ description: "x".repeat(MAX_AGENT_DESCRIPTION) }))).toBeUndefined();
  });

  it.each([
    ["no slash", "claude"],
    ["empty provider", "/claude"],
    ["empty model id", "anthropic/"],
  ])("rejects a model with %s", (_what, model) => {
    expect(agentRoleProblem(role({ model }))).toBe("model must be provider/modelId");
  });

  it("rejects an unknown thinkingLevel and accepts every pi-ai level", () => {
    expect(agentRoleProblem(role({ thinkingLevel: "extreme" }))).toContain("thinkingLevel must be one of");
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(agentRoleProblem(role({ thinkingLevel: level }))).toBeUndefined();
    }
  });

  it("reports the first problem only", () => {
    expect(agentRoleProblem(role({ name: "Bad Name", description: "" }))).toContain("Name must be");
  });

  it("agentNameProblem accepts a valid name and rejects traversal-shaped ones", () => {
    expect(agentNameProblem("reviewer")).toBeUndefined();
    expect(agentNameProblem("../outside")).toContain("lowercase letters, digits and hyphens");
    expect(agentNameProblem("a/b")).toContain("lowercase letters");
    expect(agentNameProblem(".")).toContain("lowercase letters");
  });
});
