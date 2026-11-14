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
