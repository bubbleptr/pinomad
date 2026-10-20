import AgentChatCore
import AgentChatKit
import SwiftUI

@main
struct AgentChatDemoApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                DemoConversation()
                    .navigationTitle("Flaky upload test")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
            }
        }
    }
}

struct DemoConversation: View {
    @State private var replay = Replay()
    /// Which run's steps the sheet shows: the settled history or the replay.
    @State private var openRun: DemoRun?

    var body: some View {
        Transcript {
            UserMessageView("Why does the upload test fail now and then?")
            AgentTraceView(Replay.history.trace) { openRun = .history }
            VStack(alignment: .leading, spacing: 4) {
                MarkdownView(markdown: Replay.history.answer)
                ReplyActions(markdown: Replay.history.answer)
            }

            UserMessageView("Fix it, and keep the change small.")
            AgentTraceView(replay.trace) { openRun = .replay }
            VStack(alignment: .leading, spacing: 4) {
                StreamingMarkdownView(replay.answer)
                if replay.answer.stream.isFinished {
                    ReplyActions(markdown: replay.answer.markdown)
                }
            }
        }
        .toolbar {
            Button("Replay", systemImage: "arrow.counterclockwise") {
                replay = Replay()
            }
        }
        .sheet(item: $openRun) { run in
            AgentTraceSheet(run == .history ? Replay.history.trace : replay.trace)
        }
        .task(id: ObjectIdentifier(replay)) {
            await replay.play()
        }
    }
}

enum DemoRun: Identifiable {
    case history
    case replay

    var id: Self { self }
}
