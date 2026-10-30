import PinomadCore
import SwiftUI

/// What to run on the host to get a link.
private let pairingHowTo = "Run `pinomad pair` on the host, or open Settings → Devices → Pair a device on the web, then scan the QR code or paste the link."

/// Where a link comes from when there's no deep link: scan the host's QR
/// code, or paste the link `pinomad pair` printed. A paste goes straight to
/// the confirm page — there's nothing to edit in a link.
struct PairingSources: View {
    let model: AppModel

    @State private var invalid = false

    var body: some View {
        VStack(spacing: 12) {
            Button {
                model.present(.scanner)
            } label: {
                Label("Scan QR Code", image: .scanQrCode)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.glassProminent))
            .controlSize(.large)

            // The system paste control: reading the pasteboard from a tap
            // on it needs no permission prompt. It draws its own filled
            // capsule, so a neutral tint keeps Scan the one primary action.
            PasteButton(payloadType: String.self) { strings in
                guard let pasted = strings.first else { return }
                Task { @MainActor in submit(pasted) }
            }
            .buttonBorderShape(.capsule)
            .tint(Color(.tertiarySystemFill))
            .controlSize(.large)

            if invalid {
                Text("That isn't a pairing link. Copy the full link `pinomad pair` printed, then paste again.")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func submit(_ text: String) {
        // A bad paste says so here; the confirm page is for real links.
        guard model.isPairingLink(text) else {
            invalid = true
            return
        }
        invalid = false
        model.offerPairing(text)
    }
}

/// The first-run screen: no host is paired yet. How to get a link on top,
/// the two ways in at the bottom, the account below them.
struct PairingStartView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connect to a Host")
                .font(.title2.weight(.semibold))
            Text(.init(pairingHowTo))
                .foregroundStyle(.secondary)
            Spacer(minLength: 24)
            PairingSources(model: model)
            Button {
                model.present(.account)
            } label: {
                Text(model.accountSession.map { "Account: \($0.username)" }
                     ?? "Sign in to pair the hosts on your account")
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
            .padding(.top, 12)
        }
        .padding(20)
    }
}

/// Settings → Add Host: the first-run page's ways in, for another host.
struct AddHostView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(.init(pairingHowTo))
                .foregroundStyle(.secondary)
            PairingSources(model: model)
            Spacer()
        }
        .padding(20)
        .navigationTitle("Add Host")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Every link stops here before pairing: says where it would connect, or
/// that it isn't a pairing link at all.
struct PairConfirmView: View {
    let model: AppModel
    let pending: PendingPairing

    @Environment(\.dismiss) private var dismiss
    /// The content's height — the sheet is sized to it.
    @State private var height: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let url = pending.target?.url {
                Text("Pair with this host?")
                    .font(.title3.weight(.semibold))
                Text("This device will pair with \(hostOf(url)).")
                    .foregroundStyle(.secondary)
                Text(url)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                if model.phase == .connected, let current = model.currentHostLabel {
                    Text("This disconnects \(current).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    Button { dismiss() } label: {
                        Text("Cancel").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glass))
                    Button {
                        model.pair(link: pending.link)
                        dismiss()
                    } label: {
                        Text("Pair").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glassProminent))
                }
                .controlSize(.large)
                .padding(.top, 8)
            } else {
                Text("This pairing link isn't valid")
                    .font(.title3.weight(.semibold))
                Text("Run `pinomad pair` on the host, or create a new link in Settings → Devices → Pair a device.")
                    .foregroundStyle(.secondary)
                Button { dismiss() } label: {
                    Text("OK").frame(maxWidth: .infinity)
                }
                .buttonStyle(.tactile(.glass))
                .controlSize(.large)
                .padding(.top, 8)
            }
        }
        .padding(24)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .presentationDetents([.height(height)])
    }
}
