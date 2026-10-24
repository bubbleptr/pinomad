import Foundation
import PinomadCore

/// Settings → Providers (ADR-0031): logins and custom endpoints on the
/// connected host. Request-class calls throw the host's refusal, which the
/// pages show inline (`describe`); a login's progress arrives in
/// `snapshot.providers`, not in these results.
extension AppModel {
    /// The `providers` stream, or nil before it lands or on a pre-5.21 host.
    var providers: HostProviders? { snapshot?.providers }

    /// The session a call goes out on, failing like a closed one when gone.
    private func providerSession() throws -> PinomadSession {
        guard let session else { throw SessionError.sessionClosed }
        return session
    }

    /// Start a login; the flow id to follow in `providers.logins`. A start
    /// that resolves after a host switch is cancelled there and reported as
    /// closed — it was never this page's.
    func beginLogin(provider id: String, method: LoginMethod) async throws -> String {
        let session = try providerSession()
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

    func answerLogin(_ loginId: String, prompt: UInt64, value: String) async throws {
        _ = try await providerSession().invoke(.answerLogin(loginId: loginId, promptId: prompt, value: value))
    }

    func cancelLogin(_ loginId: String) async throws {
        _ = try await providerSession().invoke(.cancelLogin(loginId: loginId))
    }

    /// Abandon a login without waiting — the page that started it is gone.
    func abandonLogin(_ loginId: String) {
        guard let session else { return }
        Task { _ = try? await session.invoke(.cancelLogin(loginId: loginId)) }
    }

    /// Remove a stored credential. Command-class: a refusal lands as a notice.
    func logout(provider id: String) {
        guard let session else { return }
        Task { _ = try? await session.invoke(.logout(providerId: id)) }
    }

    func saveCustomProvider(_ provider: CustomProviderInput, apiKey: ApiKeyChange) async throws {
        _ = try await providerSession().invoke(.saveCustomProvider(provider: provider, apiKey: apiKey))
    }

    func removeCustomProvider(_ id: String) async throws {
        _ = try await providerSession().invoke(.removeCustomProvider(providerId: id))
    }

    /// The models an endpoint serves, asked from the host.
    func listEndpointModels(
        api: CustomProviderApi, baseUrl: String, apiKey: String?, providerId: String?
    ) async throws -> [String] {
        let result = try await providerSession().invoke(
            .listEndpointModels(api: api, baseUrl: baseUrl, apiKey: apiKey, providerId: providerId))
        guard case .endpointModels(let models) = result else {
            throw SessionError.operationFailed("The host's reply wasn't a model list")
        }
        return models
    }
}
