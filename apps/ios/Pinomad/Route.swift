import SwiftUI

/// Where the navigation stack can go.
enum Route: Hashable {
    case conversation(UInt64)
    /// The draft page that creates a conversation on send.
    case newConversation
    /// The host folder picker, pushed from the draft page.
    case addProject
    /// This device's settings and the paired machines.
    case settings
    /// One paired machine's settings, by host key.
    case machine(String)
}

/// The page for a route. The root stack and the settings sheet's own stack
/// both register it — a stack honors one destination per value type.
struct RouteDestination: View {
    let model: AppModel
    let route: Route

    var body: some View {
        switch route {
        case .conversation(let id): ConversationView(model: model, conversationId: id)
        case .newConversation: NewConversationView(model: model)
        case .addProject: AddProjectView(model: model)
        case .settings: SettingsView(model: model)
        case .machine(let hostKey): MachineSettingsView(model: model, hostKey: hostKey)
        }
    }
}
