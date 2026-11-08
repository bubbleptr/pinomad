import AuthenticationServices
import UIKit

/// Runs one Sign in with Apple request through the system authorization
/// sheet. The button that starts it is our own, drawn like the other
/// provider buttons (Apple's guidelines allow a custom button); only the
/// authorization itself is the system's.
@MainActor
final class AppleSignInRequest: NSObject {
    private var controller: ASAuthorizationController?
    private var completion: ((Result<ASAuthorization, any Error>) -> Void)?

    /// `configure` fills in scopes and nonce; `completion` runs once.
    func start(
        configure: (ASAuthorizationAppleIDRequest) -> Void,
        completion: @escaping (Result<ASAuthorization, any Error>) -> Void
    ) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        configure(request)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        self.completion = completion
        controller.performRequests()
    }

    private func finish(_ result: Result<ASAuthorization, any Error>) {
        let completion = self.completion
        self.completion = nil
        controller = nil
        completion?(result)
    }
}

extension AppleSignInRequest: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        MainActor.assumeIsolated { finish(.success(authorization)) }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController, didCompleteWithError error: any Error
    ) {
        MainActor.assumeIsolated { finish(.failure(error)) }
    }
}

extension AppleSignInRequest: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
        }
    }
}
