import Foundation
import PinomadCore

/// One @ trigger in a composer: the whole token the caret is inside, and
/// the query typed from @ up to the caret.
public struct MentionToken: Equatable, Sendable {
    /// UTF-16 offsets of @ through the token's last non-whitespace
    /// character. Choosing a candidate replaces the whole token, not just
    /// the typed prefix, so a caret parked mid-token leaves no stale suffix.
    public let range: Range<Int>
    /// Text between @ and the caret (UTF-16) — what candidates match.
    public let query: String

    public init(range: Range<Int>, query: String) {
        self.range = range
        self.query = query
    }

    /// The token containing cursor (a UTF-16 offset), if any. @ must
    /// start a line or follow whitespace; a@b is an address, not a
    /// mention.
    public static func at(text: String, cursor: Int) -> MentionToken? {
        let units = Array(text.utf16)
        guard cursor > 0, cursor <= units.count else { return nil }
        // The caret has to be in the token, not on the whitespace after it.
        guard !isWhitespace(units[cursor - 1]) else { return nil }
        var start = cursor - 1
        while start > 0, !isWhitespace(units[start - 1]) { start -= 1 }
        guard units[start] == 0x40 else { return nil }
        var end = cursor
        while end < units.count, !isWhitespace(units[end]) { end += 1 }
        let query = String(decoding: units[(start + 1)..<cursor], as: UTF16.self)
        return MentionToken(range: start..<end, query: query)
    }

    /// Replaces the whole token with plain text (the host never parses the
    /// mention); the returned caret sits after the insertion.
    public func replacing(in text: String, with value: String) -> MentionInsertion {
        let units = Array(text.utf16)
        let lower = min(max(range.lowerBound, 0), units.count)
        var upper = min(max(range.upperBound, lower), units.count)
        // The insertion ends with a space; eat the separator already after
        // the token so editing a finished mention doesn't double it. Keep
        // newlines: they separate lines, not the mention.
        if value.hasSuffix(" "), upper < units.count, isHorizontalSpace(units[upper]) {
            upper += 1
        }
        var next = units
        next.replaceSubrange(lower..<upper, with: Array(value.utf16))
        return MentionInsertion(
            text: String(decoding: next, as: UTF16.self),
            cursor: lower + value.utf16.count
        )
    }
}

/// What a menu row inserts: plain text, never a host-parsed token.
public enum MentionChoice: Equatable, Sendable {
    case agent(String)
    case file(String)

    public var insertion: String {
        switch self {
        case .agent(let name): "@\(name) "
        case .file(let path): "@./\(path) "
        }
    }
}

/// A composer text after picking a mention, and where the caret goes.
public struct MentionInsertion: Equatable, Sendable {
    public let text: String
    /// UTF-16 offset just after the inserted text.
    public let cursor: Int

    public init(text: String, cursor: Int) {
        self.text = text
        self.cursor = cursor
    }
}

/// The @ menu's state: the token under the caret, local agent matches,
/// and the newest file candidates. File answers are matched by generation
/// so a slower earlier query cannot replace what the reader sees, and a
/// failure clears only files — agents don't depend on the host call.
public struct MentionMenu: Equatable, Sendable {
    /// Identifies one file query for the caller to run and later match.
    public struct FileRequest: Equatable, Sendable {
        public let generation: Int
        public let scope: FileScope
        public let query: String

        public init(generation: Int, scope: FileScope, query: String) {
            self.generation = generation
            self.scope = scope
            self.query = query
        }
    }

    public private(set) var token: MentionToken?
    public private(set) var agents: [AgentRole] = []
    public private(set) var files: [String] = []
    public private(set) var filesTruncated = false
    public private(set) var filesLoading = false
    /// The query the newest request belongs to; nil while no files are
    /// being listed.
    private var lastScope: FileScope?
    private var lastQuery: String?
    private var generation = 0

    public init() {}

    /// Whether there is a row (or a pending file answer) worth showing.
    public var isShowing: Bool {
        token != nil && (!agents.isEmpty || !files.isEmpty || filesTruncated || filesLoading)
    }

    /// Recomputes for the caret. Scope nil means files are unavailable
    /// (host before 5.10, a Chat draft, or no project chosen); agents stay
    /// local either way. A non-nil result is a new query for the caller to
    /// debounce and run.
    public mutating func refresh(
        text: String,
        cursor: Int,
        roles: [AgentRole],
        scope: FileScope?
    ) -> FileRequest? {
        guard let token = MentionToken.at(text: text, cursor: cursor) else {
            dismiss()
            return nil
        }
        self.token = token
        let needle = token.query.lowercased()
        agents = needle.isEmpty
            ? roles
            : roles.filter { $0.name.lowercased().contains(needle) }

        guard let scope else {
            clearFiles()
            return nil
        }
        // The inserted form is `@./path`; the host matches paths without
        // that marker, so editing a finished reference still finds files.
        let query = token.query.hasPrefix("./")
            ? String(token.query.dropFirst(2))
            : token.query
        guard lastScope != scope || lastQuery != query else { return nil }
        generation += 1
        lastScope = scope
        lastQuery = query
        files = []
        filesTruncated = false
        filesLoading = true
        return FileRequest(generation: generation, scope: scope, query: query)
    }

    /// The newest query's answer. Older ones are already stale.
    public mutating func receive(_ request: FileRequest, files: [String], truncated: Bool) {
        guard request.generation == generation else { return }
        self.files = files
        filesTruncated = truncated
        filesLoading = false
    }

    /// A failed query hides the file group; agent matches are unaffected.
    public mutating func fail(_ request: FileRequest) {
        guard request.generation == generation else { return }
        files = []
        filesTruncated = false
        filesLoading = false
    }

    public mutating func dismiss() {
        token = nil
        agents = []
        clearFiles()
    }

    /// New scope, query, or a closed menu invalidates whatever is in
    /// flight. Bumping only when there is something to drop keeps repeated
    /// refreshes from churning generations.
    private mutating func clearFiles() {
        if lastScope != nil || lastQuery != nil || filesLoading || !files.isEmpty || filesTruncated {
            generation += 1
        }
        lastScope = nil
        lastQuery = nil
        files = []
        filesTruncated = false
        filesLoading = false
    }
}

private func isWhitespace(_ unit: UInt16) -> Bool {
    guard let scalar = Unicode.Scalar(unit) else { return false }
    return CharacterSet.whitespacesAndNewlines.contains(scalar)
}

private func isHorizontalSpace(_ unit: UInt16) -> Bool {
    unit == 0x20 || unit == 0x09
}
