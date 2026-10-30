import Testing
@testable import PinomadCore

/// Perf runs pair hosts; a line without its host cannot be attributed.
@Suite("Perf log")
struct PerfLogTests {
    @Test func eachLineCarriesTheSourceHostSuffix() throws {
        let line = PerfLog.line(
            name: "ui-publish",
            hostKey: "host-0123456789abcdef",
            version: 7,
            ms: 12.5
        )
        #expect(line.contains("\"host\":\"89abcdef\""))
        #expect(!line.contains("host-0123456789abcdef"))
        #expect(line.contains("\"n\":\"ui-publish\""))
        #expect(line.contains("\"v\":7"))
        #expect(line.contains("\"ms\":12.5"))
        #expect(PerfLog.line(name: "hitch", hostKey: nil, version: nil, ms: 20).contains("\"host\":\"-\""))
    }
}
