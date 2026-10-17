import AgentChatCore
import Testing

@Suite struct RevealScheduleTests {
    let pace = RevealSchedule.Pace(catchUp: 0.25, fade: 0.5)

    @Test func aBurstIsSpreadEvenlyOverTheCatchUpWindow() {
        var schedule = RevealSchedule(pace: pace)
        schedule.append("one two three four ", at: 0)

        #expect(schedule.revealedLength(at: 0) == "one ".utf8.count)
        #expect(schedule.revealedLength(at: 0.07) == "one two ".utf8.count)
        #expect(schedule.revealedLength(at: 0.13) == "one two three ".utf8.count)
        #expect(schedule.revealedLength(at: 0.25) == "one two three four ".utf8.count)
    }

    // Chinese and Japanese have no spaces: each ideograph is its own step.
    @Test func ideographsRevealOneAtATime() {
        var schedule = RevealSchedule(pace: pace)
        schedule.append("你好世界", at: 0)
        #expect(schedule.revealedLength(at: 0.07) == "你好".utf8.count)
    }

    @Test func nothingShowsBeforeItArrives() {
        var schedule = RevealSchedule(pace: pace)
        schedule.append("a", at: 0)
        schedule.append(" b c", at: 1)
        #expect(schedule.revealedLength(at: 0.5) == 1)
        #expect(schedule.revealedLength(at: 1) == "a b ".utf8.count)
    }

    @Test(arguments: [1, 2, 3] as [UInt64])
    func textNeverLagsMoreThanTheCatchUpWindow(seed: UInt64) {
        var random = SplitMix(seed: seed)
        var schedule = RevealSchedule(pace: pace)
        var arrived = 0
        var time = 0.0
        var previous = 0
        for _ in 0..<200 {
            time += Double(random.next() % 120) / 1000
            let words = (0...(random.next() % 6)).map { _ in ["fix ", "the ", "race", "你", "好", "\n", "`x` "][Int(random.next() % 7)] }
            let chunk = words.joined()
            schedule.append(chunk, at: time)
            arrived += chunk.utf8.count

            #expect(schedule.revealedLength(at: time + pace.catchUp) == arrived)
            let now = schedule.revealedLength(at: time)
            #expect(now >= previous, "revealed text never shrinks")
            previous = now
        }
    }
}

/// A deterministic generator, so a failure replays.
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
