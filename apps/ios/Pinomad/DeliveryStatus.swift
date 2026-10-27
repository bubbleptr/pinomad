import PinomadChat
import SwiftUI

/// One delivery state's mark and spoken label, shared by the transcript's
/// metadata row and the composer's queued rows so the two never disagree.
extension MessageStatus {
    var icon: ImageResource {
        switch self {
        case .sending, .unknown: .clock
        case .sent: .check
        case .delivered: .checkCheck
        case .failed: .circleX
        }
    }

    var label: String {
        switch self {
        case .sending: "Sending"
        case .unknown: "Not confirmed"
        case .failed: "Failed"
        case .sent: "Sent"
        case .delivered: "Delivered"
        }
    }
}
