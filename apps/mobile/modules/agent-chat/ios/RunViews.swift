import ExpoModulesCore
import SwiftUI

#if canImport(AgentChatKit)
import AgentChatCore
import AgentChatKit

/// Measures the content once, in place: reports the subview's ideal height at
/// the proposed width to the Yoga shadow node. Replaces AutoSizingStack, whose
/// hidden second render forked every piece of @State inside the kit views
/// (disclosure, batch expansion, thinking streams) and made the measured
/// height lag the visible one.
private struct MeasuringLayout: Layout {
  var report: (CGSize) -> Void

  struct CacheValue {
    var measured = CGSize.zero
    var reported = CGFloat.nan
  }

  func makeCache(subviews: Subviews) -> CacheValue { CacheValue() }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout CacheValue) -> CGSize {
    guard let view = subviews.first else { return .zero }
    // Height is ignored on purpose: the cell's own size is what we are
    // measuring, so the content is probed at its ideal height for the width.
    cache.measured = view.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
    return cache.measured
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout CacheValue) {
    // Report from the committed pass only — sizeThatFits runs speculatively.
    if cache.measured.height != cache.reported {
      cache.reported = cache.measured.height
      report(cache.measured)
    }
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(cache.measured))
  }
}

private extension ExpoSwiftUI.ViewProps {
  /// Yoga height write-back; NaN width leaves the stretched cell width alone.
  func reportHeight(_ size: CGSize) {
    shadowNodeProxy.setViewSize?(CGSize(width: .nan, height: size.height))
  }
}

final class RunTraceProps: ExpoSwiftUI.ViewProps {
  /// JSON of `RunTracePayload`; replaced wholesale on every update batch.
  @Field var payload: String = ""
}

/// The run's chain of thought rendered by AgentChatKit's `AgentTraceView`.
/// `WithHostingView` lets RN mount it directly inside a FlatList cell — each
/// cell gets its own UIHostingController, no <Host> wrapper needed.
struct RunTraceView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunTraceProps

  var body: some View {
    MeasuringLayout(report: { props.reportHeight($0) }) {
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
      // A run handing over (open -> committed entry id) updates the payload
      // rather than remounting; only a recycled cell showing a genuinely new
      // run needs its disclosure reset, which `update(phase:)` covers.
      .id(run?.id ?? "")
  }
}

final class RunAnswerProps: ExpoSwiftUI.ViewProps {
  /// JSON of `RunAnswerPayload`; replaced wholesale on every update batch.
  @Field var payload: String = ""
}

/// The run's answer: `StreamingMarkdownView` for the paced reveal, then the
/// kit's `ReplyActions` copy row once the stream is finished.
struct RunAnswerView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
  @ObservedObject var props: RunAnswerProps

  var body: some View {
    MeasuringLayout(report: { props.reportHeight($0) }) {
      RunAnswerContent(props: props)
    }
  }
}

private struct RunAnswerContent: View {
  @ObservedObject var props: RunAnswerProps
  @State private var stream: StreamingMarkdown?
  @State private var appliedId = ""
  @State private var finished = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let stream {
        StreamingMarkdownView(stream)
        if stream.stream.isFinished {
          ReplyActions(markdown: stream.markdown)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onChange(of: props.payload, initial: true) { _, _ in sync() }
  }

  /// Feeds full-text snapshots into the append-only stream: text extending
  /// what arrived appends the delta and paces it; anything else rebuilds and
  /// shows at once — a recycled cell must never replay history.
  private func sync() {
    guard let payload = RunAnswerPayload.decode(props.payload) else { return }
    if let stream, payload.text.hasPrefix(stream.markdown) {
      // Same run continuing — the open->committed id swap lands here too.
      let delta = String(payload.text.dropFirst(stream.markdown.count))
      if !delta.isEmpty { stream.append(delta) }
    } else {
      reset(for: payload)
    }
    appliedId = payload.id
    if !payload.streaming, !finished {
      stream?.finish()
      finished = true
    }
  }

  private func reset(for payload: RunAnswerPayload) {
    appliedId = payload.id
    finished = false
    // Whatever arrived before this mount shows at once; only newer text paces.
    stream = payload.streaming
      ? StreamingMarkdown(prefilled: payload.text)
      : StreamingMarkdown(markdown: payload.text)
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
