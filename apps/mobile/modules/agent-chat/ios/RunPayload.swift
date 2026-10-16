import Foundation

#if canImport(AgentChatCore)
import AgentChatCore

/// Full snapshot of one transcript run, serialized by the JS adapter
/// (src/widgets/transcript/native-run.ts). Re-sent on every update batch;
/// decoding is cheap relative to a render.
struct RunTracePayload: Decodable, Equatable {
  var id: String
  /// CotPhase: "hidden" | "thinking" | "acting" | "answering" | "settled".
  var phase: String
  /// "failed" | "interrupted" | nil
  var outcome: String?
  /// Epoch ms of the run's first model call.
  var startedAt: Double?
  /// Epoch ms when work stopped (answer start or run end).
  var endedAt: Double?
  var steps: [Step]

  struct Step: Decodable, Equatable {
    var id: String
    /// "thinking" | "interim" | "tools"
    var kind: String
    var text: String?
    var live: Bool?
    var calls: [Call]?
  }

  struct Call: Decodable, Equatable {
    var id: String
    var name: String
    /// "streamingInput" | "running" | "succeeded" | "failed"
    var state: String
    var input: String?
    var output: String?
    var durationMs: Double?
    var children: [Call]?
  }

  static func decode(_ json: String) -> RunTracePayload? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(RunTracePayload.self, from: data)
  }

  var trace: AgentTrace {
    AgentTrace(
      phase: {
        switch phase {
        case "acting": .acting
        case "answering": .answering
        case "settled": .settled
        // "hidden" has no AgentChatKit counterpart; the adapter only mounts
        // the view once the run shows anything, so thinking is the floor.
        default: .thinking
        }
      }(),
      outcome: {
        switch outcome {
        case "failed": .failed
        case "interrupted": .interrupted
        default: .completed
        }
      }(),
      steps: steps.map(\.traceStep),
      startedAt: startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      endedAt: endedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    )
  }
}

private extension RunTracePayload.Step {
  var traceStep: TraceStep {
    switch kind {
    case "interim":
      .interim(id: id, text: text ?? "")
    case "tools":
      .tools(id: id, calls: (calls ?? []).map(\.toolCall))
    default:
      .thinking(id: id, text: text ?? "", isLive: live ?? false)
    }
  }
}

private extension RunTracePayload.Call {
  var toolCall: ToolCall {
    ToolCall(
      id: id,
      name: name,
      state: {
        switch state {
        case "streamingInput": .streamingInput
        case "running": .running
        case "failed": .failed
        default: .succeeded
        }
      }(),
      input: input,
      output: output,
      duration: durationMs.map { .milliseconds(Int64($0)) },
      children: (children ?? []).map(\.toolCall)
    )
  }
}
#endif

/// The answer of one run. `text` is the full text so far, `streaming` whether
/// more tokens are coming.
struct RunAnswerPayload: Decodable, Equatable {
  var id: String
  var text: String
  var streaming: Bool

  static func decode(_ json: String) -> RunAnswerPayload? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(RunAnswerPayload.self, from: data)
  }
}
