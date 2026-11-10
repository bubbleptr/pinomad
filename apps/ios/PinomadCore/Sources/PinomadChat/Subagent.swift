import Foundation
import PinomadCore

/// What iOS calls a conversation wherever it names one. A subagent goes by
/// its family-unique name (ADR-0046 §1) — the one its dispatcher's reports
/// and the subagent tools use — and falls back to the shared display name
/// on hosts from before names.
public func conversationName(summary: ConversationSummary) -> String {
    if summary.kind == .subagent, let name = summary.name, !name.isEmpty { return name }
    return displayName(summary: summary)
}

/// Whether the user can stop this subagent now (ADR-0047 §2), the Web's
/// `canStopSubagent`: it is at work, and the host tells its dispatcher who
/// stopped it — a 5.33 host, for a subagent it has a record of (it has a
/// name). The user never messages a subagent; an idle one has nothing to
/// stop.
public func canStopSubagent(summary: ConversationSummary, hostMinor: UInt32) -> Bool {
    hostSupportsFeature(hostMinor: hostMinor, feature: .subagentStop)
        && summary.name != nil
        && summary.status == .running
}
