import PinomadCore
import SwiftUI

/// Where a link comes from when there's no deep link: scan the host's QR
/// code, or paste the link `pinomad pair` printed.
struct PairingSources: View {
    let model: AppModel

    @State private var text = ""
    @State private var invalid = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                model.present(.scanner)
            } label: {
                Label("Scan QR code", image: .scanQrCode)
                    .labelStyle(.titleAndIcon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.glassProminent))
            .controlSize(.large)

            HStack(spacing: 8) {
                TextField("http://…#pair=… or pinomad://pair#…", text: $text)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .glassEffect(.regular, in: .capsule)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .onChange(of: text) { _, _ in invalid = false }
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first else { return }
                    Task { @MainActor in
                        text = pasted
                        submit()
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.circle)
                .buttonStyle(.tactile(.glass))
                .controlSize(.large)
            }
            if invalid {
                Text("Not a valid pairing link. Paste the full link that `pinomad pair` printed.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button("Continue", action: submit)
                .buttonStyle(.tactile(.glass))
                .controlSize(.large)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .disabled(text.allSatisfy(\.isWhitespace))
        }
    }

    private func submit() {
        guard !text.allSatisfy(\.isWhitespace) else { return }
        // A bad paste says so here; the confirm page is for real links.
        guard model.isPairingLink(text) else {
            invalid = true
            return
        }
        model.offerPairing(text)
        text = ""
    }
}

/// The first-run screen: no host is paired yet.
struct PairingStartView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Connect to a Host")
                    .font(.title2.weight(.semibold))
                Text("Run `pinomad pair` on the host, or open Settings → Devices → Pair a device on the web, then scan the QR code or paste the link.")
                    .foregroundStyle(.secondary)
            }
            PairingSources(model: model)
            Divider()
            if let session = model.accountSession {
                Button {
                    model.present(.account)
                } label: {
                    Label("Account: \(session.username)", image: .userRound)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.tactile(.glass))
                .controlSize(.large)
                Text("Pair the hosts on your account from the account page.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            } else {
                Button {
                    model.present(.account)
                } label: {
                    Label("Sign in", image: .userRound)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.tactile(.glass))
                .controlSize(.large)
                Text("Sign in to pair the hosts on your account without a QR code.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            Text("You can also open a pinomad://pair link directly.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(20)
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
