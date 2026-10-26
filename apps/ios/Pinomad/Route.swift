import PinomadCore
import SwiftUI

/// Where the navigation stack can go.
enum Route: Hashable {
    case conversation(UInt64)
    /// One list of the machine's roots: a status tile's, Chats, or a project.
    case conversations(ConversationFilter)
    /// The draft page that creates a conversation on send.
    case newConversation
    /// The host folder picker, pushed from the draft page.
    case addProject
    /// This device's settings and the paired machines.
    case settings
    /// One paired machine's settings, by host key.
    case machine(String)
    /// A paired host's connection settings and RTC status, by host key.
    case host(String)
    /// That machine's providers: what's connected, and ways to add one.
    case providers(String)
    // The pages under Providers carry the host they were opened for and act
    // on it only while it is the connected one (`providersPage`).
    /// Providers to sign in to with a subscription or account.
    case providerSubscriptions(String)
    /// Providers that take an API key.
    case providerKeys(String)
    /// One provider: its connection, or a login by the method given.
    case provider(host: String, id: String, method: LoginMethod?)
    /// Add a custom endpoint, or edit the one with this id.
    case customEndpoint(host: String, id: String?)
}

/// The page for a route. The root stack and the settings sheet's own stack
/// both register it — a stack honors one destination per value type.
struct RouteDestination: View {
    let model: AppModel
    let route: Route

    var body: some View {
        switch route {
        case .conversation(let id): ConversationView(model: model, conversationId: id)
        case .conversations(let filter): ConversationsPage(model: model, filter: filter)
        case .newConversation: NewConversationView(model: model)
        case .addProject: AddProjectView(model: model)
        case .settings: SettingsView(model: model)
        case .machine(let hostKey): MachineSettingsView(model: model, hostKey: hostKey)
        case .host(let hostKey): HostDetailView(model: model, hostKey: hostKey)
        case .providers(let hostKey): ProvidersView(model: model, hostKey: hostKey)
        case .providerSubscriptions(let hostKey):
            ProvidersGate(model: model, hostKey: hostKey) { providers in
                ProviderGridView(model: model, hostKey: hostKey, all: providers.providers, kind: .subscription)
            }
        case .providerKeys(let hostKey):
            ProvidersGate(model: model, hostKey: hostKey) { providers in
                ProviderGridView(model: model, hostKey: hostKey, all: providers.providers, kind: .apiKey)
            }
        case .provider(let hostKey, let id, let method):
            ProvidersGate(model: model, hostKey: hostKey) { _ in
                ProviderPageView(model: model, hostKey: hostKey, providerId: id, method: method)
            }
        case .customEndpoint(let hostKey, let id):
            ProvidersGate(model: model, hostKey: hostKey) { _ in
                CustomEndpointView(model: model, hostKey: hostKey, providerId: id)
            }
        }
    }
}

/// Which roots a conversations page lists.
enum ConversationFilter: Hashable {
    case all
    case needsAnswer
    case running
    case failed
    case chats
    /// By project path.
    case project(String)
}

/// Back to the Providers list from a page pushed above it, once a login
/// or endpoint is saved. Each stack that can hold those pages sets it on
/// its own path.
struct PopToProvidersAction: Equatable {
    /// Which stack's path this pops; a stack's path never changes identity,
    /// so neither does its action — dependents needn't refresh on updates.
    let stack: String
    let pop: @MainActor () -> Void

    @MainActor func callAsFunction() { pop() }

    static func == (a: Self, b: Self) -> Bool { a.stack == b.stack }
}

extension EnvironmentValues {
    @Entry var popToProviders = PopToProvidersAction(stack: "none") {}
}

extension [Route] {
    /// Drop everything above the topmost Providers list.
    mutating func popToProviders() {
        guard let index = lastIndex(where: { if case .providers = $0 { true } else { false } }) else { return }
        removeSubrange(index + 1 ..< endIndex)
    }
}
