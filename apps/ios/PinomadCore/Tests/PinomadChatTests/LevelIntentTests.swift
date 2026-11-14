import PinomadCore
import Testing
@testable import PinomadChat

private let fourLevels: [ThinkingLevel] = [.off, .low, .medium, .high]
private let threeLevels: [ThinkingLevel] = [.off, .low, .medium]

/// A conversation keeps the level the reader picked across model switches:
/// the host clamps it on its own, and only a different target needs a
/// second call (as on web).
@Suite struct LevelIntentTests {
    @Test func aModelWithoutTheLevelLeavesItToTheHostsClamp() {
        // High on GPT-5, switching to Sonnet: the host lands on Medium itself.
        #expect(LevelIntent.afterSwitch(levels: threeLevels, intent: .high, current: .high) == nil)
    }

    @Test func switchingBackRestoresThePickedLevel() {
        // Sonnet ran at Medium because of the clamp; GPT-5 has High again.
        #expect(LevelIntent.afterSwitch(levels: fourLevels, intent: .high, current: .medium) == .high)
    }

    @Test func noPickFollowsTheCurrentLevel() {
        #expect(LevelIntent.afterSwitch(levels: fourLevels, intent: .low, current: .low) == nil)
    }

    @Test func aModelWithoutLevelsAsksForNothing() {
        #expect(LevelIntent.afterSwitch(levels: [], intent: .high, current: .medium) == nil)
    }
}

@Suite struct LevelIntentsTests {
    @Test func aSwitchBackAsksForThePickedLevel() {
        var intents = LevelIntents()
        intents.pick(.high, conversation: 1, agent: nil)
        let away = intents.switchModel(conversation: 1, agent: nil, current: .high, levels: threeLevels)
        #expect(away.follow == nil)
        let back = intents.switchModel(conversation: 1, agent: nil, current: .medium, levels: fourLevels)
        #expect(back.follow == .high)
        #expect(intents.isCurrent(back.revision, conversation: 1))
    }

    /// A newer pick or an agent change while the switch is in flight makes
    /// its follow-up stale.
    @Test func aLaterChangeMakesTheFollowUpStale() {
        var intents = LevelIntents()
        intents.pick(.high, conversation: 1, agent: nil)
        let back = intents.switchModel(conversation: 1, agent: nil, current: .medium, levels: fourLevels)
        intents.pick(.low, conversation: 1, agent: nil)
        #expect(!intents.isCurrent(back.revision, conversation: 1))

        let again = intents.switchModel(conversation: 1, agent: nil, current: .medium, levels: fourLevels)
        intents.forget(conversation: 1)
        #expect(!intents.isCurrent(again.revision, conversation: 1))
    }

    /// The pick belongs to the agent it was made under; another agent,
    /// even one switched from another device, sets its own level.
    @Test func anotherAgentIgnoresThePick() {
        var intents = LevelIntents()
        intents.pick(.high, conversation: 1, agent: nil)
        let switched = intents.switchModel(conversation: 1, agent: "planner", current: .low, levels: fourLevels)
        #expect(switched.follow == nil)
    }

    /// Re-picking the clamped level that is already shown is still a pick.
    @Test func pickingTheShownLevelReplacesTheIntent() {
        var intents = LevelIntents()
        intents.pick(.high, conversation: 1, agent: nil)
        _ = intents.switchModel(conversation: 1, agent: nil, current: .high, levels: threeLevels)
        intents.pick(.medium, conversation: 1, agent: nil)
        let back = intents.switchModel(conversation: 1, agent: nil, current: .medium, levels: fourLevels)
        #expect(back.follow == nil)
    }

    @Test func conversationsKeepTheirOwnPicks() {
        var intents = LevelIntents()
        intents.pick(.high, conversation: 1, agent: nil)
        let other = intents.switchModel(conversation: 2, agent: nil, current: .medium, levels: fourLevels)
        #expect(other.follow == nil)
    }
}
