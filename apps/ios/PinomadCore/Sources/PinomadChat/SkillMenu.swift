import Foundation
import PinomadCore

/// The `$` skill menu's state: the token under the caret and the known
/// listing filtered into Project / User sections (issue #143). The listing
/// is passed in — nil means unknown (no answer yet, a failed scope, offline,
/// or a host before 5.13), so the menu stays closed and nothing highlights.
public struct SkillMenu: Equatable, Sendable {
    /// One headed source group. Sections are always Project then User; a
    /// source with no match is omitted.
    public struct Section: Equatable, Sendable, Identifiable {
        public let source: SkillSource
        public let skills: [SkillEntry]

        public var id: SkillSource { source }

        public init(source: SkillSource, skills: [SkillEntry]) {
            self.source = source
            self.skills = skills
        }
    }

    public private(set) var token: MentionToken?
    public private(set) var sections: [Section] = []
    /// Whether the last refresh had a listing at all. A known empty listing
    /// still opens the menu (with "No matching skills"); an unknown one does
    /// not.
    private var listed = false

    public init() {}

    /// Show the menu only while a `$` token is under the caret and the
    /// scope's listing is known. The token survives an unknown listing so a
    /// later answer can open the menu without retyping.
    public var isShowing: Bool { token != nil && listed }

    /// Recompute from the draft, caret and the scope's known listing. The
    /// ranking is local: name prefix > name substring > description
    /// substring, case-insensitive, listing order inside a tier.
    public mutating func refresh(text: String, cursor: Int, skills: [SkillEntry]?) {
        guard let token = MentionToken.at(text: text, cursor: cursor, trigger: "$") else {
            dismiss()
            return
        }
        self.token = token
        guard let skills else {
            listed = false
            sections = []
            return
        }
        listed = true
        sections = Self.sections(for: skills, query: token.query)
    }

    /// What a picked row inserts into the draft: plain text `$name `, never
    /// a host-parsed token.
    public func insertion(for skill: SkillEntry, in text: String) -> MentionInsertion? {
        token?.replacing(in: text, with: "$" + skill.name + " ")
    }

    public mutating func dismiss() {
        token = nil
        sections = []
        listed = false
    }

    private struct Ranked {
        let skill: SkillEntry
        let index: Int
        let tier: Int
    }

    private static func sections(for skills: [SkillEntry], query: String) -> [Section] {
        let needle = query.lowercased()
        let ranked = skills.enumerated().compactMap { index, skill -> Ranked? in
            let name = skill.name.lowercased()
            let tier: Int
            if needle.isEmpty || name.hasPrefix(needle) {
                tier = 0
            } else if name.contains(needle) {
                tier = 1
            } else if skill.description.lowercased().contains(needle) {
                tier = 2
            } else {
                return nil
            }
            return Ranked(skill: skill, index: index, tier: tier)
        }.sorted { left, right in
            left.tier == right.tier ? left.index < right.index : left.tier < right.tier
        }

        // Grouping is by entry source; the ranking stays stable inside each
        // group. Project comes first because a project skill shadows a
        // same-named user skill in the prompt.
        return [SkillSource.project, .user].compactMap { source in
            let matches = ranked.filter { $0.skill.source == source }.map(\.skill)
            return matches.isEmpty ? nil : Section(source: source, skills: matches)
        }
    }
}
