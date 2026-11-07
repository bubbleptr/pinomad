import SwiftUI

/// The account sign-in providers (ADR-0044 §3) in button order, as the web
/// client's sign-in-provider.tsx lists them.
enum SignInProviders {
    static let ids = ["apple", "google", "github"]

    static func name(_ id: String) -> String {
        switch id {
        case "google": "Google"
        case "github": "GitHub"
        case "apple": "Apple"
        default: id
        }
    }
}

/// A provider's brand mark at text size. Apple is the system symbol; Google
/// keeps its colors and GitHub follows the text color (the web client's
/// lobehub SVGs, docs/licenses/lobehub-icons.md).
struct SignInProviderMark: View {
    let provider: String
    var size: CGFloat = 18

    var body: some View {
        switch provider {
        case "apple":
            Image(systemName: "apple.logo")
                .font(.system(size: size * 0.95))
                .frame(width: size, height: size)
        case "google":
            Image("provider-google-color")
                .resizable()
                .frame(width: size, height: size)
        case "github":
            Image("provider-github")
                .resizable()
                .renderingMode(.template)
                .frame(width: size, height: size)
        default:
            EmptyView()
        }
    }
}
