// The skill listing behind the `$` menu and the bubble/composer highlights
// (issue #143): a `ListingCache` keyed by skill scope.
import type { SkillListing, SkillScope } from "@pinomad/protocol/organization.ts";
import { ListingCache } from "@/shared/listing-cache";

/** One listed skill — the name a `$` mention types, the one-line description the menu shows, and which entry supplied it. */
export type ListedSkill = SkillListing["skills"][number];

/** The stable cache partition a scope maps to — a scope change never serves another scope's list. */
export const skillScopeKey = (scope: SkillScope): string =>
  scope.kind === "conversation"
    ? `conversation:${scope.conversationId}`
    : scope.kind === "project"
      ? `project:${scope.path}:${scope.checkout}`
      : "chat";

export class SkillMentionCache extends ListingCache<SkillScope, SkillListing, ListedSkill> {
  constructor(list: (scope: SkillScope) => Promise<SkillListing>, options: { now?: () => number; ttlMs?: number } = {}) {
    super(list, skillScopeKey, (listing) => listing.skills, options);
  }
}
