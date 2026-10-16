import ExpoModulesCore
import SwiftUI

#if canImport(AgentChatKit)
import AgentChatCore
import AgentChatKit
import Observation

/// Interaction state that must live outside the view tree: `AutoSizingStack`
/// renders the content twice (a hidden measuring copy), so `@State` inside
/// AgentChatKit's views would diverge between copies and the measured height
/// would lag the visible one. Both copies share this object instead, wired
/// down through AgentChatKit's disclosure environment overrides.
@Observable
final class RunTraceUIState {
  var disclosure = TraceDisclosure(phase: .thinking)
  var expandedCalls = Set<String>()
  private(set) var runId = ""

  /// Reset when the recycled cell starts showing a different run.
  func sync(_ run: RunTracePayload?) {
    guard let run, run.id != runId else { return }
    runId = run.id
    disclosure = TraceDisclosure(phase: run.trace.phase)
    expandedCalls = []
  }
}

final class RunTraceProps: ExpoSwiftUI.ViewProps {
  /// JSON of `RunTracePayload`; replaced wholesale on every update batch.
  @Field var payload: String = ""
  let ui = RunTraceUIState()
}

/// The run's chain of thought rendered by AgentChatKit's `AgentTraceView`.
/// `WithHostingView` lets RN mount it directly inside a FlatList cell — each
/// cell gets its own UIHostingController, no <Host> wrapper needed.
struct RunTraceView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunTraceProps

  var body: some View {
    ExpoSwiftUI.AutoSizingStack(shadowNodeProxy: props.shadowNodeProxy, axis: .vertical) {
      RunTraceContent(props: props)
    }
  }
}

private struct RunTraceContent: View {
  let props: RunTraceProps

  var body: some View {
    let run = RunTracePayload.decode(props.payload)
    AgentTraceView(run?.trace ?? AgentTrace(phase: .thinking, steps: []))
      .padding(.vertical, 2)
      // The hosting root centers non-expanding content; stretch so the
      // header hugs the leading edge like the RN transcript does.
      .frame(maxWidth: .infinity, alignment: .leading)
      .environment(\.traceDisclosureOverride, Binding(
        get: { props.ui.disclosure },
        set: { props.ui.disclosure = $0 }))
      .environment(\.expandedCallIds, Binding(
        get: { props.ui.expandedCalls },
        set: { props.ui.expandedCalls = $0 }))
      // A new run in this recycled cell starts its disclosure over.
      .id(run?.id ?? "")
      .onChange(of: run?.id, initial: true) { _, _ in
        props.ui.sync(run)
      }
  }
}

final class RunAnswerProps: ExpoSwiftUI.ViewProps {
  /// JSON of `RunAnswerPayload`; replaced wholesale on every update batch.
  @Field var payload: String = ""

  /// Shared so the measuring copy reveals exactly what the visible copy does.
  /// Optional because `StreamingMarkdown` is main-actor; `sync` creates it.
  private(set) var stream: StreamingMarkdown?
  private var appliedId = ""
  private var finished = false

  /// Feeds full-text snapshots into the append-only stream: text extending
  /// what arrived only appends the delta; anything else rebuilds the stream.
  @MainActor
  func sync() {
    guard let payload = RunAnswerPayload.decode(payload) else { return }
    if payload.id != appliedId || (finished && payload.streaming) {
      reset(for: payload)
      return
    }
    guard let stream else { return }
    let arrived = stream.markdown
    if payload.text != arrived {
      if payload.text.hasPrefix(arrived) {
        stream.append(String(payload.text.dropFirst(arrived.count)))
      } else {
        reset(for: payload)
        return
      }
    }
    if !payload.streaming, !finished {
      stream.finish()
      finished = true
    }
  }

  @MainActor
  private func reset(for payload: RunAnswerPayload) {
    appliedId = payload.id
    finished = false
    // Settled history mounts instantly — no reveal animation.
    stream = payload.streaming ? StreamingMarkdown() : StreamingMarkdown(markdown: payload.text)
    if payload.streaming, let stream, !payload.text.isEmpty {
      stream.append(payload.text)
    }
    // The view reads `stream` when props change; a swap needs an explicit nudge.
    objectWillChange.send()
  }
}

/// The run's answer rendered by `StreamingMarkdownView` (paced word fade-in).
struct RunAnswerView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunAnswerProps

  var body: some View {
    // Same measurement trick as Expo's AutoSizingStack(.vertical), written
    // out so the two copies share `props.stream` — the pacing state would
    // diverge if it lived in per-copy @State.
    RunAnswerContent(props: props)
      .overlay {
        RunAnswerContent(props: props)
          .fixedSize(horizontal: false, vertical: true)
          .hidden()
          .onGeometryChange(for: CGSize.self, of: { $0.size }) { size in
            // NaN width leaves Yoga's width alone, same as AutoSizingStack(.vertical).
            props.shadowNodeProxy.setViewSize?(CGSize(width: .nan, height: size.height))
          }
      }
  }
}

private struct RunAnswerContent: View {
  @ObservedObject var props: RunAnswerProps

  var body: some View {
    Group {
      if let stream = props.stream {
        StreamingMarkdownView(stream)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .onChange(of: props.payload, initial: true) { _, _ in props.sync() }
  }
}
#else
final class RunTraceProps: ExpoSwiftUI.ViewProps {
  @Field var payload: String = ""
}

struct RunTraceView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunTraceProps
  var body: some View { EmptyView() }
}

final class RunAnswerProps: ExpoSwiftUI.ViewProps {
  @Field var payload: String = ""
}

struct RunAnswerView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunAnswerProps
  var body: some View { EmptyView() }
}
#endif
