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

/// Signed in, and the account has no hosts: the one-use `pinomad join`
/// command to run on a computer, ready to copy or send there, with a
/// pairing link one tap away and the account below.
struct FirstHostView: View {
    let model: AppModel
    let refreshError: String?

    @State private var token: JoinToken?
    @State private var error: String?
    @State private var busy = false
    @State private var copied = false
    @State private var pastingLink = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Add your first host")
                        .font(.title2.weight(.semibold))
                    Text("A host is the computer that runs your agents: a Mac or Linux machine with Node 25 or later. Open a terminal there and run:")
                        .foregroundStyle(.secondary)
                }

                command

                Text("It installs PiNomad, joins the host to your account and keeps it running as a service. The host then shows up here and connects on its own.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

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
        .animation(Motion.reveal, value: pastingLink)
        // Each command works once: mint on the first appearance only.
        .task {
            if token == nil && error == nil { await create() }
        }
    }

    @ViewBuilder
    private var command: some View {
        if let token {
            VStack(alignment: .leading, spacing: 12) {
                Text(token.command)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 12))

                HStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = token.command
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy", image: copied ? .check : .copy)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glassProminent))
                    .sensoryFeedback(.success, trigger: copied)

                    // AirDrop, Messages or Mail to the computer that will run it.
                    ShareLink(item: token.command) {
                        Label("Share", image: .share)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glass))
                }
                .controlSize(.large)

                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = PairingCodeCopy.remainingSeconds(expiresAt: token.expiresAt, now: context.date)
                    if seconds == 0 {
                        HStack(spacing: 12) {
                            Text("Expired")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button("New command") { Task { await create() } }
                                .buttonStyle(.tactile(.bordered))
                                .controlSize(.small)
                                .disabled(busy)
                        }
                    } else {
                        Text("Works once · expires in \(PairingCodeCopy.countdown(seconds))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }

                if let error {
                    Text("Couldn't create a new command. \(error)")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        } else if let error {
            VStack(alignment: .leading, spacing: 10) {
                Text("Couldn't create a join command. \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Try again") { Task { await create() } }
                    .buttonStyle(.tactile(.bordered))
                    .disabled(busy)
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Creating a command…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func create() async {
        busy = true
        error = nil
        let result = await model.accountCreateJoinToken()
        busy = false
        switch result {
        case .success(let value):
            token = value
            copied = false
        case .failure(let failure):
            error = AccountCopy.message(failure)
        }
    }
}
