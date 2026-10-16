import ExpoModulesCore

/// Spike module exporting AgentChatKit-backed views for one transcript run:
/// `RunTraceView` renders the chain of thought, `RunAnswerView` the answer.
public class PinomadAgentChatModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PinomadAgentChat")
    View(RunTraceView.self)
    View(RunAnswerView.self)
  }
}
