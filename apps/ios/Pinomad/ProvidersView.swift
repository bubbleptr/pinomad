import PinomadChat
import PinomadCore
import SwiftUI

/// Settings → Providers (ADR-0031): what's connected, then three ways to
/// add one — subscription, API key, custom endpoint. Everything shown comes
/// from the `providers` stream, so a login finished on another device
/// appears here the moment the host pushes it.
struct ProvidersView: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        Group {
            if hostKey != model.currentHostKey || model.snapshot == nil {
                ContentUnavailableView {
                    Label("Not connected to this host", image: .cloudOff)
                } description: {
                    Text("Connect to it to see its providers.")
                }
            } else if let providers = model.providers {
                ProvidersHomeList(home: ProvidersHome(providers.providers), connected: model.connected)
            } else if model.hostSupports("beginLogin") {
                // A 5.21 host sends the snapshot right after connecting.
                ProgressView()
            } else {
                ContentUnavailableView {
                    Label("Update the host", image: .triangleAlert)
                } description: {
                    Text("Run `pinomad upgrade` on the host to add providers here.")
                }
            }
        }
        .navigationTitle("Providers")
    }
}

private struct ProvidersHomeList: View {
    let home: ProvidersHome
    let connected: Bool

    var body: some View {
        List {
            if !home.connected.isEmpty {
                Section("Connected") {
                    ForEach(home.connected, id: \.id) { provider in
                        NavigationLink(value: provider.custom == nil
                                       ? Route.provider(provider.id, nil) : Route.customEndpoint(provider.id)) {
                            ProviderRow(provider: provider)
                        }
                    }
                }
            }
            Section {
                PathRow(
                    title: "Subscription",
                    detail: "Use a plan you already pay for.",
                    foot: home.subscriptionFoot,
                    logos: home.subscriptions.map { ($0.id, $0.name) },
                    route: .providerSubscriptions)
                PathRow(
                    title: "API key",
                    detail: "Pay per token with a key from the provider.",
                    foot: "\(home.keyed.count) providers",
                    logos: home.keyLogos.map { ($0.id, $0.name) },
                    route: .providerKeys)
                PathRow(
                    title: "Custom endpoint",
                    detail: "Your own server or gateway.",
                    foot: "Ollama, LM Studio, vLLM, any OpenAI- or Anthropic-compatible URL",
                    logos: [("ollama", "Ollama"), ("lmstudio", "LM Studio")],
                    route: .customEndpoint(nil))
            } header: {
                Text(home.connected.isEmpty ? "Connect a model provider" : "Add another")
            } footer: {
                Text("Credentials stay on the host, and every device paired with it uses them.")
            }
            .disabled(!connected)
        }
    }
}

/// A connected provider: logo, name, and where its auth comes from.
private struct ProviderRow: View {
    let provider: ProviderInfo

    var body: some View {
        HStack(spacing: 12) {
            ProviderLogo(id: provider.id, name: provider.name, baseUrl: provider.custom?.baseUrl)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                Text(provider.credentialLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// One way to add a provider, with a few logos of what it covers.
private struct PathRow: View {
    let title: String
    let detail: String
    let foot: String
    let logos: [(id: String, name: String)]
    let route: Route

    var body: some View {
        NavigationLink(value: route) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(logos, id: \.id) { logo in
                        ProviderLogo(id: logo.id, name: logo.name, size: 28)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(detail).font(.subheadline)
                    Text(foot)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

/// The subscription page and the API key page: every provider offering
/// that way in, as a grid of tiles.
struct ProviderGridView: View {
    enum Kind { case subscription, apiKey }

    let model: AppModel
    let kind: Kind

    @State private var query = ""

    var body: some View {
        let all = model.providers?.providers ?? []
        let shown = kind == .subscription ? subscriptionProviders(all) : keyProviders(all, matching: query)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if kind == .subscription {
                    Text("Use a plan you already pay for. Requests count against the plan instead of per-token billing.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if shown.isEmpty && !query.isEmpty {
                    Text("No provider matches “\(query.trimmingCharacters(in: .whitespaces))”. If it speaks an OpenAI- or Anthropic-compatible API, add it as a custom endpoint.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    ForEach(shown, id: \.id) { provider in
                        tile(provider)
                    }
                }
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(kind == .subscription ? "Sign in with an account" : "API key")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(KeySearch(enabled: kind == .apiKey, query: $query, count: all.filter(\.takesKey).count))
    }

    private func tile(_ provider: ProviderInfo) -> some View {
        let method: LoginMethod = kind == .subscription ? .oauth : .apiKey
        let caption: String? = kind == .subscription
            ? (provider.oauth?.subscription == true ? provider.planCaption : "Account sign-in")
            : nil
        return NavigationLink(value: Route.provider(provider.id, method)) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    ProviderLogo(id: provider.id, name: provider.name, size: 36)
                    Spacer()
                    if provider.stored?.kind == method {
                        Text("Connected")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.green.opacity(0.15), in: .capsule)
                    }
                }
                Text(provider.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        }
        .buttonStyle(.press)
        .disabled(!model.connected)
    }
}

/// The API key page filters its long list; the subscription page is short.
private struct KeySearch: ViewModifier {
    let enabled: Bool
    @Binding var query: String
    let count: Int

    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $query, prompt: "Filter \(count) providers")
        } else {
            content
        }
    }
}

/// A provider's logo on a rounded tile, or its initials when there is none.
/// A custom endpoint passes its `baseUrl` and gets Ollama's logo on
/// Ollama's port. Decorative: the name always sits beside it.
struct ProviderLogo: View {
    let id: String
    let name: String
    var baseUrl: String? = nil
    var size: CGFloat = 32

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
        Group {
            if let asset = providerLogoAsset(id: id, baseUrl: baseUrl) {
                Image(asset)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size * 0.62, height: size * 0.62)
                    .foregroundStyle(.primary)
            } else {
                Text(providerInitials(name))
                    .font(.system(size: size * 0.38, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(Color(.tertiarySystemGroupedBackground), in: shape)
        .overlay(shape.strokeBorder(.separator, lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}
