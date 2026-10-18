import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func role(_ name: String, _ description: String = "") -> AgentRole {
    AgentRole(name: name, description: description, model: nil, thinkingLevel: nil, prompt: "")
}

@Suite struct MentionTokenTests {
    @Test func atLineStart() {
        let token = MentionToken.at(text: "@rev", cursor: 4)
        #expect(token == MentionToken(range: 0..<4, query: "rev"))
    }

    @Test func afterAWhitespace() {
        #expect(MentionToken.at(text: "ask @rev", cursor: 8)
            == MentionToken(range: 4..<8, query: "rev"))
        #expect(MentionToken.at(text: "ask\n@rev", cursor: 8)
            == MentionToken(range: 4..<8, query: "rev"))
    }

    /// A name only starts a mention at a boundary; the @ in an address
    /// is part of the address.
    @Test func emailAddressesDoNotTrigger() {
        #expect(MentionToken.at(text: "a@b", cursor: 3) == nil)
        #expect(MentionToken.at(text: "mail a@b", cursor: 8) == nil)
    }

    /// The caret can sit in the middle of a mention while editing it. The
    /// query is the prefix before the caret; the token spans the whole
    /// word so choosing replaces the stale suffix too.
    @Test func caretInTheMiddleKeepsTheWholeToken() {
        let token = MentionToken.at(text: "@reviewer", cursor: 4)
        #expect(token == MentionToken(range: 0..<9, query: "rev"))
    }

    @Test func cjkAndEmojiKeepUTF16OffsetsRight() {
        // 你(1) 好(1) emoji(2) space(1) = 5 units, then @r.
        let token = MentionToken.at(text: "你好🙂 @r", cursor: 7)
        #expect(token == MentionToken(range: 5..<7, query: "r"))
    }

    @Test func whitespaceEndsTheToken() {
        #expect(MentionToken.at(text: "@re v", cursor: 3)
            == MentionToken(range: 0..<3, query: "re"))
        #expect(MentionToken.at(text: "@re v", cursor: 4) == nil)
        #expect(MentionToken.at(text: "@re v", cursor: 5) == nil)
    }

    @Test func caretOutsideTheTokenDoesNotTrigger() {
        #expect(MentionToken.at(text: "@rev ", cursor: 5) == nil)
        #expect(MentionToken.at(text: "ask @rev", cursor: 3) == nil)
        #expect(MentionToken.at(text: "", cursor: 0) == nil)
    }

    @Test func choicesInsertThePlainTextTheHostExpects() {
        #expect(MentionChoice.agent("reviewer").insertion == "@reviewer ")
        #expect(MentionChoice.file("Sources/App.swift").insertion == "@./Sources/App.swift ")
    }

    @Test func selectionReplacesTheTokenAndMovesTheCaretAfterIt() throws {
        let text = "ask @reviewer please"
        let token = try #require(MentionToken.at(text: text, cursor: 8))
        let insertion = token.replacing(in: text, with: "@review ")
        #expect(insertion.text == "ask @review please")
        #expect(insertion.cursor == "ask @review ".utf16.count)
    }
}

@Suite struct MentionMenuTests {
    private let scope = FileScope.conversation(conversationId: 7)

    @Test func agentsAppearLocallyWithNoRequest() {
        var menu = MentionMenu()
        let request = menu.refresh(
            text: "@re", cursor: 3, roles: [role("reviewer"), role("writer")], scope: nil)
        #expect(request == nil)
        #expect(menu.agents.map { $0.name } == ["reviewer"])
        #expect(menu.isShowing)
    }

    @Test func emptyQueryListsEveryAgent() {
        var menu = MentionMenu()
        _ = menu.refresh(
            text: "@", cursor: 1, roles: [role("reviewer"), role("writer")], scope: nil)
        #expect(menu.agents.map { $0.name } == ["reviewer", "writer"])
    }

    @Test func newestFileAnswerWins() throws {
        var menu = MentionMenu()
        let firstRequest = menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope)
        let secondRequest = menu.refresh(text: "@re", cursor: 3, roles: [], scope: scope)
        let first = try #require(firstRequest)
        let second = try #require(secondRequest)
        #expect(menu.filesLoading)
        menu.receive(first, files: ["old"], truncated: false)
        #expect(menu.files.isEmpty)
        #expect(menu.filesLoading)
        menu.receive(second, files: ["new"], truncated: true)
        #expect(menu.files == ["new"])
        #expect(menu.filesTruncated)
        #expect(!menu.filesLoading)
    }

    @Test func aFileFailureLeavesAgentsAlone() throws {
        var menu = MentionMenu()
        let requestValue = menu.refresh(
            text: "@r", cursor: 2, roles: [role("reviewer")], scope: scope)
        let request = try #require(requestValue)
        menu.fail(request)
        #expect(menu.agents.map { $0.name } == ["reviewer"])
        #expect(menu.files.isEmpty)
        #expect(!menu.filesLoading)
        #expect(menu.isShowing)
    }

    @Test func closingDropsALateAnswer() throws {
        var menu = MentionMenu()
        let requestValue = menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope)
        let request = try #require(requestValue)
        menu.dismiss()
        menu.receive(request, files: ["late"], truncated: false)
        #expect(menu.files.isEmpty)
        #expect(menu.token == nil)
    }

    @Test func aNewScopeInvalidatesTheOldRequest() throws {
        var menu = MentionMenu()
        let firstRequest = menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope)
        let secondRequest = menu.refresh(
            text: "@r", cursor: 2, roles: [], scope: .conversation(conversationId: 8))
        let first = try #require(firstRequest)
        let second = try #require(secondRequest)
        menu.receive(first, files: ["old"], truncated: false)
        #expect(menu.files.isEmpty)
        menu.receive(second, files: ["new"], truncated: false)
        #expect(menu.files == ["new"])
    }

    /// The menu inserts `@./path`; editing that mention must query the path
    /// the host knows, not the display prefix.
    @Test func fileQueriesDropTheReferencePrefix() throws {
        var menu = MentionMenu()
        let requestValue = menu.refresh(
            text: "@./Sources", cursor: 10, roles: [], scope: scope)
        let request = try #require(requestValue)
        #expect(request.query == "Sources")
        #expect(menu.filesLoading)
    }

    @Test func theSameQueryIsNotAskedAgain() throws {
        var menu = MentionMenu()
        _ = menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope)
        #expect(menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope) == nil)
    }

    @Test func losingTheScopeClearsFilesAndDropsTheRequest() throws {
        var menu = MentionMenu()
        let requestValue = menu.refresh(text: "@r", cursor: 2, roles: [], scope: scope)
        let request = try #require(requestValue)
        _ = menu.refresh(text: "@r", cursor: 2, roles: [], scope: nil)
        #expect(!menu.filesLoading)
        menu.receive(request, files: ["late"], truncated: false)
        #expect(menu.files.isEmpty)
    }

    @Test func whitespaceClosesTheMenu() {
        var menu = MentionMenu()
        _ = menu.refresh(text: "@r", cursor: 2, roles: [role("reviewer")], scope: scope)
        _ = menu.refresh(text: "@r ", cursor: 3, roles: [role("reviewer")], scope: scope)
        #expect(menu.token == nil)
        #expect(!menu.isShowing)
    }

    /// A host before 5.6 has no agents, and one before 5.10 no files: an
    /// @ alone must not leave an empty glass card open.
    @Test func nothingToShowMeansNoMenu() {
        var menu = MentionMenu()
        _ = menu.refresh(text: "@", cursor: 1, roles: [], scope: nil)
        #expect(!menu.isShowing)
    }
}
