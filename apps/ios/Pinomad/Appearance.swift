import SwiftUI

/// Light, dark, or whatever the system uses. Kept on this device only;
/// applied once at the app's root so sheets, menus and UIKit-hosted views
/// follow it too.
enum Appearance: String, CaseIterable, Identifiable {
    case light, dark, system

    static let storageKey = "device.appearance"

    var id: Self { self }

    var label: String {
        switch self {
        case .light: "Light"
        case .dark: "Dark"
        case .system: "System"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: .light
        case .dark: .dark
        case .system: nil
        }
    }
}
