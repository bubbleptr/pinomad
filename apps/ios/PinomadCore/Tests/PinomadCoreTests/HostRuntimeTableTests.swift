import Testing
@testable import PinomadCore

/// The app owns the runtime objects; this table owns the part that must not
/// depend on which one is on screen: stored order, the single focus, and the
/// conversation released when focus moves (ADR-0035 §1, §2).
@Suite("Host runtime table")
struct HostRuntimeTableTests {
    @Test func opensOnTheRememberedHostAndKeepsStoredOrder() {
        let table = HostRuntimeTable(hostKeys: ["home", "office"], rememberedHostKey: "office")
        #expect(table.hostKeys == ["home", "office"])
        #expect(table.focus == HostFocus(hostKey: "office"))
        #expect(table.focusedConversation == nil)
    }

    @Test func unknownRememberedHostFallsBackToTheFirst() {
        #expect(HostRuntimeTable(hostKeys: ["home"], rememberedHostKey: "gone").focus
            == HostFocus(hostKey: "home"))
        #expect(HostRuntimeTable(hostKeys: []).focus == nil)
    }

    @Test func focusingAnotherHostsConversationReleasesTheOldOne() {
        var table = HostRuntimeTable(hostKeys: ["home", "office"])
        #expect(table.focusConversation(ConversationRef(hostKey: "home", conversationId: 7)) == nil)
        #expect(table.focusedConversation == ConversationRef(hostKey: "home", conversationId: 7))

        let released = table.focusConversation(ConversationRef(hostKey: "office", conversationId: 9))
        #expect(released == ConversationRef(hostKey: "home", conversationId: 7))
        #expect(table.focusedConversation == ConversationRef(hostKey: "office", conversationId: 9))
        #expect(table.hostKeys == ["home", "office"])
    }

    @Test func sameHostSwitchIsTheCoresToRelease() {
        var table = HostRuntimeTable(hostKeys: ["home"])
        table.focusConversation(ConversationRef(hostKey: "home", conversationId: 1))
        #expect(table.focusConversation(ConversationRef(hostKey: "home", conversationId: 2)) == nil)
        // Going back to the draft still releases the conversation explicitly.
        #expect(table.focusDraft(on: "home") == ConversationRef(hostKey: "home", conversationId: 2))
        #expect(table.focus == HostFocus(hostKey: "home"))
    }

    @Test func forgettingTheFocusedHostFallsBackWithoutItsConversation() {
        var table = HostRuntimeTable(hostKeys: ["home", "office"], rememberedHostKey: "home")
        table.focusConversation(ConversationRef(hostKey: "home", conversationId: 4))
        #expect(table.forget("home") == ConversationRef(hostKey: "home", conversationId: 4))
        #expect(table.focus == HostFocus(hostKey: "office"))
        #expect(table.focusedConversation == nil)
        // Forgetting the unfocused host leaves the focus alone.
        #expect(table.forget("office") == nil)
        #expect(table.focus == nil)
    }

    @Test func aPairingIsAppendedAndFocusedOnlyWhenAsked() {
        var table = HostRuntimeTable(hostKeys: ["home"])
        table.focusConversation(ConversationRef(hostKey: "home", conversationId: 3))
        #expect(table.addPairedHost("work", focus: false) == nil)
        #expect(table.focus == HostFocus(hostKey: "home", conversationId: 3))
        #expect(table.hostKeys == ["home", "work"])

        #expect(table.addPairedHost("office", focus: true) == ConversationRef(hostKey: "home", conversationId: 3))
        #expect(table.focus == HostFocus(hostKey: "office"))
    }

    @Test func synchronizingDropsForgottenHostsAndKeepsValidFocus() {
        var table = HostRuntimeTable(hostKeys: ["home", "office"], rememberedHostKey: "office")
        #expect(table.synchronize(["home", "office", "work"]) == nil)
        #expect(table.hostKeys == ["home", "office", "work"])
        #expect(table.focus == HostFocus(hostKey: "office"))

        #expect(table.synchronize(["home"]) == nil)
        #expect(table.focus == HostFocus(hostKey: "home"))
        #expect(table.synchronize([]) == nil)
        #expect(table.focus == nil)
    }
}
