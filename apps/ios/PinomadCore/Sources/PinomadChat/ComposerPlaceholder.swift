/// The composer's placeholder: a lead, then a short hint for each trigger
/// that works here — "Ask · @ agent or file · / command · $ skill" — so the
/// triggers are discoverable. Same copy as Web; the full set has to stay on
/// one line in an iPhone-width composer.
public enum ComposerPlaceholder {
    /// Each flag is false when the host or scope can't offer that trigger.
    public static func text(lead: String, agents: Bool, files: Bool, commands: Bool, skills: Bool) -> String {
        let mention: String? = agents && files ? "@ agent or file"
            : agents ? "@ agent"
            : files ? "@ file"
            : nil
        let hints = [mention, commands ? "/ command" : nil, skills ? "$ skill" : nil].compactMap { $0 }
        return ([lead] + hints).joined(separator: " · ")
    }
}
