import Foundation
import PinomadCore

/// Settings → Providers (ADR-0031): logins and custom endpoints on the
/// connected host. Request-class calls throw the host's refusal, which the
/// pages show inline (`describe`); a login's progress arrives in
/// `snapshot.providers`, not in these results.
///
/// Every call names the host its page was opened for and goes out only
/// while that host is the connected one: a login, key or endpoint never
/// lands on another machine.
extension AppModel {
    /// The `providers` stream, or nil before it lands or on a pre-5.21 host.
    var providers: HostProviders? { snapshot?.providers }

    /// The session a call to `host` goes out on, failing like a closed one
    /// when that host isn't the connected one.
    private func providerSession(on host: String) throws -> PinomadSession {
        guard currentHostKey == host, let session else { throw SessionError.sessionClosed }
        return session
    }

    /// Start a login; the flow id to follow in `providers.logins`. A start
    /// that resolves after a host switch is cancelled there and reported as
    /// closed — it was never this page's.
    func beginLogin(provider id: String, method: LoginMethod, on host: String) async throws -> String {
        let session = try providerSession(on: host)
        let generation = sessionGeneration
        guard case .loginStarted(let loginId) = try await session.invoke(.beginLogin(providerId: id, method: method)) else {
            throw SessionError.operationFailed("The host's reply wasn't a login")
        }
        guard sessionGeneration == generation, self.session === session else {
            _ = try? await session.invoke(.cancelLogin(loginId: loginId))
            throw SessionError.sessionClosed
        }
        return loginId
    }

    func answerLogin(_ loginId: String, prompt: UInt64, value: String, on host: String) async throws {
        _ = try await providerSession(on: host).invoke(.answerLogin(loginId: loginId, promptId: prompt, value: value))
    }

    func cancelLogin(_ loginId: String, on host: String) async throws {
        _ = try await providerSession(on: host).invoke(.cancelLogin(loginId: loginId))
    }

    /// Abandon a login without waiting — the page that started it is gone.
    /// Once another host is connected the flow can't be reached; its own
    /// host times it out.
    func abandonLogin(_ loginId: String, on host: String) {
        guard let session = try? providerSession(on: host) else { return }
        Task { _ = try? await session.invoke(.cancelLogin(loginId: loginId)) }
    }

    /// Remove a stored credential. Command-class: a refusal lands as a notice.
    func logout(provider id: String, on host: String) {
        guard let session = try? providerSession(on: host) else { return }
        Task { _ = try? await session.invoke(.logout(providerId: id)) }
    }

    func saveCustomProvider(_ provider: CustomProviderInput, apiKey: ApiKeyChange, on host: String) async throws {
        _ = try await providerSession(on: host).invoke(.saveCustomProvider(provider: provider, apiKey: apiKey))
    }

    func removeCustomProvider(_ id: String, on host: String) async throws {
        _ = try await providerSession(on: host).invoke(.removeCustomProvider(providerId: id))
    }

    /// The models an endpoint serves, asked from the host.
    func listEndpointModels(
        api: CustomProviderApi, baseUrl: String, apiKey: String?, providerId: String?, on host: String
    ) async throws -> [String] {
        let result = try await providerSession(on: host).invoke(
            .listEndpointModels(api: api, baseUrl: baseUrl, apiKey: apiKey, providerId: providerId))
        guard case .endpointModels(let models) = result else {
            throw SessionError.operationFailed("The host's reply wasn't a model list")
        }
        return models
    }
}
