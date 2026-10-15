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
            MarkdownView(markdown: Replay.history.answer)

            UserMessageView("Fix it, and keep the change small.")
            AgentTraceView(replay.trace)
            StreamingMarkdownView(replay.answer)
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
