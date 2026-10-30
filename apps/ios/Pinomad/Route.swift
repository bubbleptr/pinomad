import PinomadCore
import SwiftUI

/// Where the navigation stack can go. Host-related destinations carry their
/// hostKey so #429 can list every machine without changing the route shape
/// (ADR-0035 §1).
enum Route: Hashable {
    case conversation(ConversationRef)
    /// One list of roots: a machine's Chats or project, or a status tile's
    /// across every machine (nil host).
    case conversations(hostKey: String?, filter: ConversationFilter)
    /// Why a machine can't be used, and the ways out.
    case machineUnavailable(String)
    /// The draft page that creates a conversation on send.
    case newConversation(hostKey: String)
    /// The host folder picker, pushed from the draft page.
    case addProject(hostKey: String)
    /// This device's settings and the paired machines.
    case settings
    /// Scan or paste a pairing link, pushed from Settings.
    case addHost
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
        case .conversation(let ref): ConversationView(model: model, ref: ref)
        case .conversations(let hostKey, let filter):
            ConversationsPage(model: model, hostKey: hostKey, filter: filter)
        case .machineUnavailable(let hostKey): MachineUnavailableView(model: model, hostKey: hostKey)
        case .newConversation: NewConversationView(model: model)
        case .addProject: AddProjectView(model: model)
        case .settings: SettingsView(model: model)
        case .addHost: AddHostView(model: model)
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

extension Route {
    /// The host whose page this is, which the focus follows (#429); nil
    /// for pages of no host or of every host.
    var page: HostFocus? {
        switch self {
        case .conversation(let ref): HostFocus(hostKey: ref.hostKey, conversationId: ref.conversationId)
        case .conversations(let hostKey, _): hostKey.map { HostFocus(hostKey: $0) }
        case .newConversation(let hostKey), .addProject(let hostKey), .machineUnavailable(let hostKey),
             .machine(let hostKey), .host(let hostKey), .providers(let hostKey),
             .providerSubscriptions(let hostKey), .providerKeys(let hostKey),
             .provider(let hostKey, _, _), .customEndpoint(let hostKey, _):
            HostFocus(hostKey: hostKey)
        case .settings, .addHost: nil
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
