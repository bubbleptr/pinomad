import Foundation
import PinomadCore

/// Settings → Providers (ADR-0031): logins and custom endpoints on the
/// connected host. Request-class calls throw the host's refusal, which the
/// pages show inline (`describe`); a login's progress arrives in that host's
/// snapshot, not in these results.
///
/// Every call names the host its page was opened for and goes out on that
/// host's runtime: a login, key or endpoint never lands on another machine,
/// and a focus change does not cancel it.
extension AppModel {
    /// The `providers` stream of the focused host, or nil before it lands or
    /// on a pre-5.21 host.
    var providers: HostProviders? { snapshot?.providers }

    /// The runtime a call to `host` goes out on, failing like a closed one
    /// when that host is not connected.
    private func providerRuntime(on host: String) throws -> HostRuntime {
        guard let runtime = runtimes[host], runtime.isConnectedNow else {
            throw SessionError.sessionClosed
        }
        return runtime
    }

    /// Start a login; the flow id to follow in `providers.logins`. A start
    /// that resolves after its host's session was replaced is cancelled there
    /// and reported as closed — it was never this page's.
    func beginLogin(provider id: String, method: LoginMethod, on host: String) async throws -> String {
        let runtime = try providerRuntime(on: host)
        guard let session = runtime.session else { throw SessionError.sessionClosed }
        let generation = runtime.generation
        guard case .loginStarted(let loginId) = try await session.invoke(
            .beginLogin(providerId: id, method: method))
        else {
            throw SessionError.operationFailed("The host's reply wasn't a login")
        }
        guard runtime.generation == generation, runtime.session === session else {
            _ = try? await session.invoke(.cancelLogin(loginId: loginId))
            throw SessionError.sessionClosed
        }
        return loginId
    }

    func answerLogin(_ loginId: String, prompt: UInt64, value: String, on host: String) async throws {
        _ = try await providerRuntime(on: host).session?.invoke(
            .answerLogin(loginId: loginId, promptId: prompt, value: value))
    }

    func cancelLogin(_ loginId: String, on host: String) async throws {
        _ = try await providerRuntime(on: host).session?.invoke(.cancelLogin(loginId: loginId))
    }

    /// Abandon a login without waiting — the page that started it is gone.
    func abandonLogin(_ loginId: String, on host: String) {
        guard let session = try? providerRuntime(on: host).session else { return }
        Task { _ = try? await session.invoke(.cancelLogin(loginId: loginId)) }
    }

    /// Remove a stored credential. Command-class: a refusal lands as a notice.
    func logout(provider id: String, on host: String) {
        guard let session = try? providerRuntime(on: host).session else { return }
        Task { _ = try? await session.invoke(.logout(providerId: id)) }
    }

    func saveCustomProvider(_ provider: CustomProviderInput, apiKey: ApiKeyChange, on host: String) async throws {
        _ = try await providerRuntime(on: host).session?.invoke(
            .saveCustomProvider(provider: provider, apiKey: apiKey))
    }

    func removeCustomProvider(_ id: String, on host: String) async throws {
        _ = try await providerRuntime(on: host).session?.invoke(
            .removeCustomProvider(providerId: id))
    }

    /// The models an endpoint serves, asked from the host.
    func listEndpointModels(
        api: CustomProviderApi, baseUrl: String, apiKey: String?, providerId: String?, on host: String
    ) async throws -> [String] {
        guard let result = try await providerRuntime(on: host).session?.invoke(
            .listEndpointModels(api: api, baseUrl: baseUrl, apiKey: apiKey, providerId: providerId))
        else { throw SessionError.sessionClosed }
        guard case .endpointModels(let models) = result else {
            throw SessionError.operationFailed("The host's reply wasn't a model list")
        }
        return models
    }
}
