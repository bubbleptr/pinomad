import Testing
@testable import PinomadChat

/// The placeholder names only the triggers that work here, so a hint never
/// points at a menu that won't open.
@Suite struct ComposerPlaceholderTests {
    @Test func noTriggerIsJustTheLead() {
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: false, files: false, commands: false, skills: false)
            == "Ask")
    }

    @Test func agentsAndFilesShareOneMentionHint() {
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: true, files: true, commands: false, skills: false)
            == "Ask · @ agent or file")
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: false, files: true, commands: false, skills: false)
            == "Ask · @ file")
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: true, files: false, commands: false, skills: false)
            == "Ask · @ agent")
    }

    @Test func aMissingTriggerDropsOnlyItsHint() {
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: true, files: true, commands: true, skills: true)
            == "Ask · @ agent or file · / command · $ skill")
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: true, files: true, commands: false, skills: true)
            == "Ask · @ agent or file · $ skill")
        #expect(ComposerPlaceholder.text(lead: "Ask", agents: false, files: false, commands: true, skills: false)
            == "Ask · / command")
    }
}
