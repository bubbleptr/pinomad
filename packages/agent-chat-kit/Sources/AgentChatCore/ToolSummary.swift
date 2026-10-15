import Foundation

/// A batch of tool calls folded to one line's worth of structure; the view
/// turns it into words. Names the call still running while the batch is
/// live, and once settled reads as what the batch did — verbs in first-seen
/// order — rather than "the last tool and a number".
public struct ToolSummary: Sendable, Equatable {
    /// What a call did, for the folded label. Each case carries a past-tense
    /// verb and the noun it counts; the view picks the words.
    public enum Verb: Sendable, Equatable {
        case ran
        case read
        case edited
        case wrote
        case searchedPattern
        case searchedPath
        case listed
        case searchedWeb
        case fetched
        /// Anything the name table does not know.
        case used
    }

    /// Calls sharing a verb, counted together.
    public struct Bucket: Sendable, Equatable {
        public var verb: Verb
        public var count: Int

        public init(verb: Verb, count: Int) {
            self.verb = verb
            self.count = count
        }
    }

    /// The call to name while the batch runs: the last in-progress top-level
    /// call, and the deepest in-progress call under it when there is one.
    public struct Running: Sendable, Equatable, Hashable {
        public var name: String
        public var nestedName: String?

        public init(name: String, nestedName: String? = nil) {
            self.name = name
            self.nestedName = nestedName
        }
    }

    /// The settled one-line summary.
    public enum Label: Sendable, Equatable {
        /// One call: its verb, what it acted on when it has a target, and its
        /// raw name for the fallback.
        case single(verb: Verb, target: String?, name: String)
        /// Several calls: verbs in first-seen order.
        case buckets([Bucket])
    }

    /// The call in progress, while any call is streaming input or running.
    public var running: Running?
    public var label: Label
    /// Line changes summed over top-level calls; a call's children keep
    /// their own stats out of the batch's.
    public var diffStat: DiffStat?
    /// Top-level calls that failed; a parent that caught a child's failure
    /// still succeeded, so children stay out of the count.
    public var failedCount: Int

    public init(calls: [ToolCall]) {
        running = Self.runningCall(in: calls)
        label = Self.label(for: calls)
        diffStat = calls.reduce(nil) { sum, call in
            guard let stat = call.diffStat else { return sum }
            return DiffStat(
                additions: (sum?.additions ?? 0) + stat.additions,
                deletions: (sum?.deletions ?? 0) + stat.deletions
            )
        }
        failedCount = calls.count { $0.state == .failed }
    }

    private static func runningCall(in calls: [ToolCall]) -> Running? {
        guard let active = calls.last(where: { $0.isInProgress }) else { return nil }
        var nested: String?
        var cursor = active
        while let next = cursor.children.last(where: { $0.isInProgress }) {
            nested = next.name
            cursor = next
        }
        return Running(name: active.name, nestedName: nested)
    }

    private static func label(for calls: [ToolCall]) -> Label {
        if calls.count == 1, let call = calls.first {
            let verb = verb(for: call.name)
            // An unknown call's input is arbitrary — JSON, prose — and
            // cannot stand in as its target; the name is the fallback.
            return .single(verb: verb, target: verb == .used ? nil : target(of: call), name: call.name)
        }
        var buckets: [Bucket] = []
        for call in calls {
            let verb = verb(for: call.name)
            if let index = buckets.firstIndex(where: { $0.verb == verb }) {
                buckets[index].count += 1
            } else {
                buckets.append(Bucket(verb: verb, count: 1))
            }
        }
        return .buckets(buckets)
    }

    /// Aliases share the short name's verb so `read_file` buckets with
    /// `read`; `write_file` keeps "wrote" rather than collapsing into
    /// "edited".
    private static func verb(for name: String) -> Verb {
        switch name.trimmingCharacters(in: .whitespaces).lowercased().replacing("-", with: "_") {
        case "bash", "shell", "sh", "terminal", "cmd": .ran
        case "read", "read_file", "cat": .read
        case "edit", "str_replace": .edited
        case "write", "write_file": .wrote
        case "grep", "search": .searchedPattern
        case "find", "glob": .searchedPath
        case "ls": .listed
        case "web_search", "websearch": .searchedWeb
        case "webfetch", "web_fetch", "web", "browser": .fetched
        default: .used
        }
    }

    /// A path's news is its tail, a command's is its head; the view
    /// truncates what still does not fit.
    private static func target(of call: ToolCall) -> String? {
        guard let input = call.input?.trimmingCharacters(in: .whitespacesAndNewlines),
              let line = input.split(separator: "\n", maxSplits: 1).first.map(String.init),
              !line.isEmpty
        else { return nil }
        if line.contains("/"), !line.contains(" ") {
            return line.split(separator: "/").last.map(String.init)
        }
        return line
    }
}

extension ToolCall {
    var isInProgress: Bool {
        state == .running || state == .streamingInput
    }
}
