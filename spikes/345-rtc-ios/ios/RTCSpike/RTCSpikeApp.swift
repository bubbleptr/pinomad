import SwiftUI

@main
struct RTCSpikeApp: App {
    @StateObject private var controller = SpikeController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(controller: controller)
                .onAppear { controller.startIfNeeded() }
        }
        .onChange(of: scenePhase) { _, phase in
            controller.scenePhaseChanged(phase)
        }
    }
}

struct ContentView: View {
    @ObservedObject var controller: SpikeController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("PiNomad RTC spike")
                .font(.title2.bold())
            HStack {
                Text(controller.status)
                    .font(.headline.monospaced())
                Spacer()
                Text("idle")
                    .font(.caption)
                    .hidden()
            }
            Text(controller.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(controller.logLines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: 9, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding()
    }
}
