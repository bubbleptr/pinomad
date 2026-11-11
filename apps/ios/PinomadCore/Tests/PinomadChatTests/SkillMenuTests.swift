import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func skill(
    _ name: String,
    _ description: String = "",
    _ source: SkillSource = .project
) -> SkillEntry {
    SkillEntry(name: name, description: description, source: source)
}

@Suite struct SkillMentionTokenTests {
    @Test func afterWhitespaceAndNewlines() {
        #expect(MentionToken.at(text: "ask $rev", cursor: 8, trigger: "$")
            == MentionToken(range: 4..<8, query: "rev"))
        #expect(MentionToken.at(text: "ask\n$rev", cursor: 8, trigger: "$")
            == MentionToken(range: 4..<8, query: "rev"))
        #expect(MentionToken.at(text: "ask\u{00A0}$rev", cursor: 8, trigger: "$")
            == MentionToken(range: 4..<8, query: "rev"))
    }

    @Test func atCannotUseTheSkillTrigger() {
        #expect(MentionToken.at(text: "$rev", cursor: 4) == nil)
    }
}

@Suite struct SkillMenuTests {
    private let project = [skill("deploy", "Ship it"), skill("review", "Review changes")]
    private let user = [skill("release", "Cut a release", .user), skill("write", "Draft prose", .user)]

    @Test func triggerFiltersByNamePrefixFirst() {
        var menu = SkillMenu()
        menu.refresh(text: "$re", cursor: 3, skills: project + user)
        #expect(menu.token == MentionToken(range: 0..<3, query: "re"))
        #expect(menu.sections.map { $0.skills.map(\.name) } == [["review"], ["release"]])
    }

    @Test func nameSubstringBeatsDescriptionSubstring() {
        var menu = SkillMenu()
        menu.refresh(text: "$it", cursor: 3, skills: [
            skill("deploy", "ship it"),
            skill("commit", "write it down"),
        ])
        // "commit" has "it" in its name; "deploy" only in its description.
        #expect(menu.sections.flatMap(\.skills).map(\.name) == ["commit", "deploy"])
    }

    @Test func filteringIsCaseInsensitiveAndStableWithinATier() {
        var menu = SkillMenu()
        menu.refresh(text: "$RE", cursor: 3, skills: [
            skill("review", ""),
            skill("release", ""),
            skill("preview", ""),
        ])
        #expect(menu.sections.flatMap(\.skills).map(\.name) == ["review", "release", "preview"])
    }

    @Test func emptyQueryListsEverythingInListingOrder() {
        var menu = SkillMenu()
        menu.refresh(text: "$", cursor: 1, skills: project + user)
        #expect(menu.sections.map(\.source) == [.project, .user])
        #expect(menu.sections.flatMap(\.skills).map(\.name) == ["deploy", "review", "release", "write"])
    }

    /// Group headings follow the ranking (the Web menu's rule); every item
    /// of a group keeps the ranking's order inside it.
    @Test func groupingFollowsTheRankingAndKeepsEachGroupsOrder() {
        var menu = SkillMenu()
        menu.refresh(text: "$re", cursor: 3, skills: [
            skill("write", "release notes", .user),
            skill("deploy", "ship", .project),
            skill("release", "", .user),
            skill("review", "", .project),
        ])
        #expect(menu.sections.map(\.source) == [.user, .project])
        #expect(menu.sections.map { $0.skills.map(\.name) } == [["release", "write"], ["review"]])
    }

    @Test func aUserPrefixBeatsAProjectDescriptionAndComesFirst() {
        var menu = SkillMenu()
        menu.refresh(text: "$re", cursor: 3, skills: [
            skill("deploy", "release steps", .project),
            skill("release", "", .user),
        ])
        #expect(menu.sections.map(\.source) == [.user, .project])
        #expect(menu.sections.map { $0.skills.map(\.name) } == [["release"], ["deploy"]])
    }

    @Test func noMatchesStillShowsTheMenu() {
        var menu = SkillMenu()
        menu.refresh(text: "$HOME", cursor: 5, skills: project)
        #expect(menu.isShowing)
        #expect(menu.sections.isEmpty)
    }

    @Test func anUnknownListHidesTheMenu() {
        var menu = SkillMenu()
        menu.refresh(text: "$", cursor: 1, skills: nil)
        #expect(!menu.isShowing)
        // The token is kept so a list arriving later can open it without
        // retyping the dollar.
        #expect(menu.token == MentionToken(range: 0..<1, query: ""))
    }

    @Test func aKnownEmptyListShowsNoMatches() {
        var menu = SkillMenu()
        menu.refresh(text: "$", cursor: 1, skills: [])
        #expect(menu.isShowing)
        #expect(menu.sections.isEmpty)
    }

    @Test func leavingTheTokenClosesTheMenu() {
        var menu = SkillMenu()
        menu.refresh(text: "$re", cursor: 3, skills: project)
        menu.refresh(text: "$re ", cursor: 4, skills: project)
        #expect(!menu.isShowing)
        #expect(menu.token == nil)
    }

    @Test func selectingInsertsPlainText() throws {
        var menu = SkillMenu()
        menu.refresh(text: "ask $re", cursor: 7, skills: project)
        let insertion = try #require(menu.insertion(for: project[1], in: "ask $re"))
        #expect(insertion.text == "ask $review ")
        #expect(insertion.cursor == "ask $review ".utf16.count)
    }

    @Test func dismissDropsEverything() {
        var menu = SkillMenu()
        menu.refresh(text: "$re", cursor: 3, skills: project)
        menu.dismiss()
        #expect(!menu.isShowing)
        #expect(menu.token == nil)
        #expect(menu.sections.isEmpty)
    }
}
