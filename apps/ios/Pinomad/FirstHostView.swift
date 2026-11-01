import PinomadCore
import SwiftUI
import UIKit

/// Where the docs explain pairing without an account.
private let noAccountDocs = URL(string: "https://pinomad.si/docs/")!

/// The page with no stored host: the add-your-first-host home for a
/// signed-in account with no hosts at all (#493), today's connect page
/// otherwise. Signed in, it asks for the account's hosts every few seconds
/// on either screen, so a host joined from a terminal takes over by itself;
/// leaving this page (a host paired here) ends the asking.
struct NoHostPage: View {
    let model: AppModel

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let home = model.noHostHome
        Group {
            switch home.screen {
            case .connect:
                PairingStartView(model: model)
            case .firstHost(let refreshError):
                FirstHostView(model: model, refreshError: refreshError)
            }
        }
        // A suspended app's timer doesn't run; coming back to the
        // foreground refreshes on its own and restarts this loop.
        .task(id: home.refreshesAccountHosts && scenePhase == .active) {
            guard home.refreshesAccountHosts, scenePhase == .active else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: NoHostHome.refreshInterval)
                guard !Task.isCancelled else { return }
                await model.accountRefreshHosts()
            }
        }
    }
}

/// Signed in, and the account has no hosts: the command to run on a
/// computer and the field for the code it shows (#497), with a pairing link
/// one tap away and the account below.
struct FirstHostView: View {
    let model: AppModel
    let refreshError: String?

    @State private var pastingLink = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Add your first host")
                        .font(.title2.weight(.semibold))
                    Text("A host is the computer that runs your agents: a Mac or Linux machine. Open a terminal there and run:")
                        .foregroundStyle(.secondary)
                }

                AddAccountHostContent(model: model)

                if let refreshError {
                    Label {
                        Text("Couldn't check for new hosts. \(refreshError)")
                    } icon: {
                        Image(.circleAlert)
                    }
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 4) {
                        Text("Not using an account?")
                            .foregroundStyle(.secondary)
                        Link("Pair a host directly", destination: noAccountDocs)
                    }
                    .font(.footnote)

                    if pastingLink {
                        Text("Scan the QR code or paste the link from pinomad pair or Settings → Devices → Pair a device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        PairingSources(model: model)
                    } else {
                        Button("Have a pairing link?") { pastingLink = true }
                            .font(.footnote)
                            .buttonStyle(.borderless)
                    }
                }

                if let session = model.accountSession {
                    Button {
                        model.present(.account)
                    } label: {
                        Text("Account: \(session.username)")
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 4)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .animation(Motion.reveal, value: pastingLink)
    }
}
