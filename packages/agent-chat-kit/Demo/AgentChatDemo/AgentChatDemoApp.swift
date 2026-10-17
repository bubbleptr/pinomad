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

    var body: some View {
        Transcript {
            UserMessageView("Why does the upload test fail now and then?")
            AgentTraceView(Replay.history.trace)
            VStack(alignment: .leading, spacing: 4) {
                MarkdownView(markdown: Replay.history.answer)
                ReplyActions(markdown: Replay.history.answer)
            }

            UserMessageView("Fix it, and keep the change small.")
            AgentTraceView(replay.trace)
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
        .task(id: ObjectIdentifier(replay)) {
            await replay.play()
        }
    }
}
