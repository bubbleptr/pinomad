import Foundation

/// A failed run's error as the reader sees it. Provider errors arrive as
/// pi-ai formats them, the HTTP status and then the provider's JSON body
/// (`401 {"type":"error","error":{"message":"invalid x-api-key"},…}`);
/// the summary keeps the status and the provider's message, and the raw
/// text stays available as the details.
public struct RunFailureText: Equatable, Sendable {
    public let summary: String
    /// Whether the summary left something out of the raw text.
    public let hasDetails: Bool

    public init(_ raw: String) {
        if let parsed = Self.statusAndMessage(raw) {
            summary = parsed.status.map { "\($0) · \(parsed.message)" } ?? parsed.message
            hasDetails = true
        } else {
            summary = raw
            hasDetails = false
        }
    }

    private static func statusAndMessage(_ raw: String) -> (status: Substring?, message: String)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var status: Substring?
        var body = Substring(trimmed)
        let digits = trimmed.prefix(while: \.isASCII).prefix(while: \.isNumber)
        if digits.count == 3, trimmed.dropFirst(3).first?.isWhitespace == true {
            status = digits
            body = trimmed.dropFirst(3).drop(while: \.isWhitespace)
        }
        guard body.first == "{",
              let object = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
              let message = message(in: object)
        else { return nil }
        return (status, message)
    }

    /// Anthropic and OpenAI nest it as `error.message`; some providers put
    /// `message` at the top, or a bare string in `error`.
    private static func message(in object: [String: Any]) -> String? {
        let candidates: [Any?] = [
            (object["error"] as? [String: Any])?["message"],
            object["message"],
            object["error"],
        ]
        return candidates.lazy.compactMap { $0 as? String }.first { !$0.isEmpty }
    }
}
