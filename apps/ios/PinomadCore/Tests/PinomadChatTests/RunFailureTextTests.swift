import Testing
@testable import PinomadChat

@Suite struct RunFailureTextTests {
    /// pi-ai prefixes the provider's error body with its HTTP status; the
    /// reader needs the status and the provider's own sentence.
    @Test func anthropicErrorBodyReadsAsStatusAndMessage() {
        let raw = #"401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CfxeSnjv6KoHcae"}"#
        let text = RunFailureText(raw)
        #expect(text.summary == "401 · invalid x-api-key")
        #expect(text.hasDetails)
    }

    @Test func openAIErrorBodyReadsAsStatusAndMessage() {
        let raw = #"429 {"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}"#
        #expect(RunFailureText(raw).summary == "429 · Rate limit reached for requests")
    }

    @Test func bodyWithoutStatusKeepsTheMessage() {
        #expect(RunFailureText(#"{"error":{"message":"overloaded"}}"#).summary == "overloaded")
        #expect(RunFailureText(#"{"message":"bad request"}"#).summary == "bad request")
        #expect(RunFailureText(#"500 {"error":"internal"}"#).summary == "500 · internal")
    }

    /// Anything that isn't a status and a JSON body with a message shows as written.
    @Test(arguments: [
        "The run failed.",
        "400 Bad Request",
        "500 {not json",
        #"503 {"status":"unavailable"}"#,
    ])
    func otherTextShowsAsWritten(raw: String) {
        let text = RunFailureText(raw)
        #expect(text.summary == raw)
        #expect(!text.hasDetails)
    }
}
