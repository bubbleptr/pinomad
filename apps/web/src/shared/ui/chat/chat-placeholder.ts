/** What the composer's triggers reach here; each is false when the host or scope can't offer it. */
export type ComposerOffers = {
  readonly agents: boolean;
  readonly files: boolean;
  readonly commands: boolean;
  readonly skills: boolean;
};

/**
 * The composer's placeholder: `lead`, then a short hint for each trigger that
 * works here — "Ask · @ agent or file · / command · $ skill". The full set has
 * to stay on one line in a 375px-wide conversation composer.
 */
export function composerPlaceholder(lead: string, offers: ComposerOffers): string {
  const mention =
    offers.agents && offers.files ? "@ agent or file" : offers.agents ? "@ agent" : offers.files ? "@ file" : undefined;
  const hints = [mention, offers.commands ? "/ command" : undefined, offers.skills ? "$ skill" : undefined].filter(
    (hint) => hint !== undefined,
  );
  return [lead, ...hints].join(" · ");
}
