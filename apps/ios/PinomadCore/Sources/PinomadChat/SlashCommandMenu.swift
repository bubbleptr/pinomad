import Foundation
import PinomadCore

/// The `/` command menu's state (issue #254, ADR-0027): the message's first
/// token while the caret is in it, and the host's listing filtered by the
/// typed prefix. Unlike `@` and `$`, a slash only triggers at index 0 — a
/// slash later in the text is a path or prose. The listing is passed in;
/// nil means unknown (no answer yet, an old host, the draft page), and the
/// menu stays closed.
public struct SlashCommandMenu: Equatable, Sendable {
    public private(set) var token: MentionToken?
    /// Matches in listing order. Disabled entries stay, greyed by the view.
    public private(set) var commands: [CommandEntry] = []
    private var listed = false

    public init() {}

    /// A known listing with no match still shows (the reader learns the
    /// text goes out as a message); an unknown one does not.
    public var isShowing: Bool { token != nil && listed }

    public mutating func refresh(text: String, cursor: Int, commands: [CommandEntry]?) {
        guard let token = MentionToken.at(text: text, cursor: cursor, trigger: "/"),
              token.range.lowerBound == 0
        else {
            dismiss()
            return
        }
        self.token = token
        guard let commands else {
            listed = false
            self.commands = []
            return
        }
        listed = true
        let needle = token.query.lowercased()
        self.commands = commands.filter { $0.name.lowercased().hasPrefix(needle) }
    }

    /// `/name ` in place of the whole first token; any arguments stay.
    public func insertion(for command: CommandEntry, in text: String) -> MentionInsertion? {
        token?.replacing(in: text, with: "/" + command.name + " ")
    }

    public mutating func dismiss() {
        token = nil
        commands = []
        listed = false
    }
}

/// What the `+` menu's "add" entries put into a draft: a bare trigger that
/// opens the matching `@` / `$` menu once the field has focus.
public enum ComposerTrigger {
    /// Replace `selection` with `trigger`, kept apart from neighbouring
    /// text: a leading space after a non-space, and a trailing space before
    /// one (otherwise the following word joins the token and a pick eats
    /// it). The caret lands right after the trigger. Offsets are UTF-16;
    /// an out-of-range selection clamps to the end.
    public static func insert(_ trigger: String, into text: String, selection: NSRange) -> MentionInsertion {
        let units = Array(text.utf16)
        let lower = min(max(selection.location, 0), units.count)
        let upper = min(lower + max(selection.length, 0), units.count)
        let before = units[..<lower]
        let after = units[upper...]
        var inserted = ""
        if let last = before.last, !isWhitespace(last) { inserted += " " }
        inserted += trigger
        let cursor = lower + inserted.utf16.count
        if let next = after.first, !isWhitespace(next) { inserted += " " }
        let next = Array(before) + Array(inserted.utf16) + Array(after)
        return MentionInsertion(text: String(decoding: next, as: UTF16.self), cursor: cursor)
    }
}

private func isWhitespace(_ unit: UInt16) -> Bool {
    guard let scalar = Unicode.Scalar(unit) else { return false }
    return CharacterSet.whitespacesAndNewlines.contains(scalar)
}
