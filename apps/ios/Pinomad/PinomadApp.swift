import PinomadCore
import SwiftUI

@main
struct PinomadApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    @AppStorage(Appearance.storageKey) private var appearance = Appearance.system
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .preferredColorScheme(appearance.colorScheme)
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
