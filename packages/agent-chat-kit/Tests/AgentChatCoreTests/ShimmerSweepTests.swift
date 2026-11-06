import AgentChatCore
import Testing

@Suite struct ShimmerSweepTests {
    // A fixed period swept a long row several times faster than a short one.
    // The highlight moves at one speed whatever the text, and rests as long.
    @Test func aLongRowSweepsAtTheSameSpeedAsAShortOneAndRestsAsLong() {
        let short = ShimmerSweep(width: 66, pointSize: 15)
        let long = ShimmerSweep(width: 400, pointSize: 15)

        let distance = { (sweep: ShimmerSweep) in
            sweep.bandOrigin(at: sweep.sweepDuration) - sweep.bandOrigin(at: 0)
        }
        #expect(distance(long) > distance(short))
        #expect(abs(distance(long) / long.sweepDuration - distance(short) / short.sweepDuration) < 1e-9)
        #expect(long.restDuration == short.restDuration)
        #expect(abs((long.period - long.sweepDuration) - (short.period - short.sweepDuration)) < 1e-9)
    }

    // The band enters from just off the leading edge and leaves just past the
    // trailing one, then stays out of sight through the rest.
    @Test func theBandStartsAndRestsOffTheText() {
        let sweep = ShimmerSweep(width: 120, pointSize: 15)

        #expect(sweep.bandOrigin(at: 0) == -sweep.band)
        #expect(abs(sweep.bandOrigin(at: sweep.sweepDuration) - 120) < 1e-9)
        #expect(abs(sweep.bandOrigin(at: sweep.sweepDuration + sweep.restDuration / 2) - 120) < 1e-9)
        #expect(sweep.bandOrigin(at: sweep.period) == -sweep.band)
    }
}
