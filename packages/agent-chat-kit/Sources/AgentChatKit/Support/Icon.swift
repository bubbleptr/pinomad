import SwiftUI

/// The kit's Lucide icons, custom symbols in `Icons.xcassets` (listed in
/// `scripts/lucide-icons.txt`). Named here rather than through generated
/// asset symbols, which `swift build` does not produce for packages.
enum Icon: String {
    case brain
    case check
    case chevronRight = "chevron-right"
    case circle
    case circleCheck = "circle-check"
    case circleDot = "circle-dot"
    case circleX = "circle-x"
    case code
    case copy
    case fileText = "file-text"
    case globe
    case pencil
    case search
    case square
    case squareCheck = "square-check"
    case squareTerminal = "square-terminal"
    case users
    case wrench
}

extension Image {
    init(_ icon: Icon) {
        self.init(icon.rawValue, bundle: .module)
    }
}
