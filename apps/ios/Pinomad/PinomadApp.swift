import PinomadCore
import SwiftUI

@main
struct PinomadApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { model.start() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: model.didEnterForeground()
                    case .background: model.didEnterBackground()
                    default: break
                    }
                }
        }
    }
}
