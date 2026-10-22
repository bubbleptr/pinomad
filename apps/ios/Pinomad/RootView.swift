import AgentChatKit
import PinomadChat
import PinomadCore
import SwiftUI

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack(path: $model.navPath) {
            Group {
                switch model.phase {
                case .loading:
                    HomeSkeleton()
                case .pairing:
                    PairingStartView(model: model)
                case .connecting:
                    connectingView
                case .connected:
                    ConversationListView(model: model)
                case .failed(let failure):
                    FailureView(model: model, failure: failure).padding()
                }
            }
            // Connected, the home page has no title: its machine groups say where you are.
            .navigationTitle(model.phase == .connected ? "" : "PiNomad")
        }
        .overlay(alignment: .top) {
            if !model.sheetShowsToasts { ToastStack(model: model) }
        }
        // Above every page — conversations and the draft both stage and
        // show images — so a tap anywhere opens here and nothing lingers.
        .environment(\.inlineImageLoader, model.inlineImageLoader)
        .environment(\.inlineImageEpoch, model.imageEpoch)
        .fullScreenCover(item: Binding(
            get: { model.viewing.map(ViewedImage.init) },
            set: { model.viewing = $0?.image }
        )) { viewed in
            ImageViewer(image: viewed.image) { model.viewing = nil }
                .presentationBackground(.clear)
        }
        .sheet(item: $model.modal, onDismiss: model.modalDismissed) { modal in
            switch modal {
            case .settings: SettingsSheet(model: model)
            case .account: AccountView(model: model)
            case .pairingCode: PairingCodeView(model: model)
            case .scanner: ScannerView(model: model)
            case .confirm(let pending): PairConfirmView(model: model, pending: pending)
            }
        }
        .sensoryFeedback(.success, trigger: model.pairings)
        // `pinomad://pair#…` — the confirm page decides what to do with it.
        .onOpenURL { url in model.offerPairing(url.absoluteString) }
        // Forgetting could not clear the host-side registration; the only
        // remaining path is revoking this device from the host.
        .alert("Push registration not cleared", isPresented: Binding(
            get: { model.pushForgetWarning != nil },
            set: { if !$0 { model.pushForgetWarning = nil } }
        )) {
            Button("OK") { model.pushForgetWarning = nil }
        } message: {
            Text(model.pushForgetWarning ?? "")
        }
    }

    /// The home page's shape — where a connection lands — with what it is
    /// waiting on and the ways out at the bottom.
    private var connectingView: some View {
        HomeSkeleton()
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    Text(model.currentHostLabel.map { "Connecting to \($0)…" } ?? "Connecting…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if model.pairingLink != nil {
                        Button("Cancel") { model.cancelPairing() }
                    } else if model.hosts.hosts.count > 1 {
                        Button("Switch host") { model.present(.settings) }
                    }
                }
                .padding(.bottom, 16)
            }
    }
}

/// Why the host can't be used, and the ways out that fit: a fresh link,
/// forgetting the host, updating one side, retrying, or another host.
private struct FailureView: View {
    let model: AppModel
    let failure: ConnectFailure

    private var pairing: Bool { model.pairingLink != nil }

    var body: some View {
        VStack(spacing: 16) {
            Image(.triangleAlert)
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text(title)
                .font(.title2)
                .multilineTextAlignment(.center)
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            VStack(spacing: 10) {
                if canRetry {
                    Button("Try again") { model.retryConnection() }
                        .buttonStyle(.tactile(.borderedProminent))
                }
                if failure == .revoked, let key = model.currentHostKey {
                    if model.accountHostId(for: key) != nil {
                        Button("Pair again with your account") { model.repairViaAccount(hostKey: key) }
                            .buttonStyle(.tactile(.bordered))
                            .disabled(model.accountBusy)
                    }
                    Button("Forget this host", role: .destructive) { model.forget(key) }
                        .buttonStyle(.tactile(.bordered))
                }
                if pairing {
                    Button("Cancel") { model.cancelPairing() }
                        .buttonStyle(.tactile(.bordered))
                }
                if let previous = model.previousHostKey {
                    Button("Back to \(model.hostLabels[previous] ?? "the previous host")") { model.switchHost(previous) }
                        .buttonStyle(.tactile(.bordered))
                }
                if !pairing {
                    Button("Settings") { model.present(.settings) }
                        .buttonStyle(.tactile(.bordered))
                }
            }
            .controlSize(.large)
            if failure == .revoked, let error = model.accountError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var canRetry: Bool {
        switch failure {
        case .unreachable, .hostOutdated: true
        case .pairingRefused, .revoked, .appOutdated: false
        }
    }

    private var title: String {
        switch failure {
        case .pairingRefused: "This pairing code is no longer valid"
        case .revoked: "The host refused or revoked this device"
        case .appOutdated: "Update the app"
        case .hostOutdated: "Update the host"
        case .unreachable: "Couldn't reach the host"
        }
    }

    private var detail: String {
        switch failure {
        case .pairingRefused:
            "It was already used or has expired. Run pinomad pair on the host, or create a new link in Settings → Devices → Pair a device."
        case .revoked:
            "It isn't paired with \(model.currentHostLabel ?? "this host"), or its pairing was revoked."
        case .appOutdated(let host, let client):
            "The host uses protocol version \(ConnectFailure.versionText(host)), but this app uses version \(ConnectFailure.versionText(client))."
        case .hostOutdated(let host, let client):
            "This app uses protocol version \(ConnectFailure.versionText(client)), but the host uses version \(ConnectFailure.versionText(host)). Run pinomad upgrade on the host."
        case .unreachable(let message):
            message
        }
    }
}

/// The live connection's trouble, above a page's content: reconnecting on
/// its own, or closed and waiting for the reader to reconnect.
struct ConnectionBanner: View {
    let model: AppModel

    var body: some View {
        // The parent animates so the bar slides in and out, not only swaps.
        ZStack {
            content.transition(.move(edge: .top).combined(with: .opacity))
        }
        .animation(Motion.reveal, value: model.phase == .connected ? model.snapshot?.connection : nil)
    }

    @ViewBuilder
    private var content: some View {
        if let connection = model.snapshot?.connection, model.phase == .connected {
            switch connection {
            case .reconnecting:
                bar {
                    ProgressView().controlSize(.small)
                    Text("Reconnecting…")
                }
            case .closed:
                bar {
                    Image(.cloudOff)
                    Text("Disconnected")
                    Spacer(minLength: 8)
                    Button("Reconnect") { model.retryConnection() }
                        .buttonStyle(.tactile(.bordered))
                        .controlSize(.small)
                }
            case .connected, .outdated:
                EmptyView()
            }
        }
    }

    private func bar(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8) { content() }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
            .padding(.horizontal, 12)
    }
}

/// Host and core notices, newest at the bottom; tap to dismiss early.
/// Also laid over sheets — a modal would otherwise hide the only report
/// of why an action in it didn't stick.
struct ToastStack: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            ForEach(model.toasts, id: \.id) { notice in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if notice.level == "error" || notice.level == "warning" {
                        Image(.circleAlert)
                            .foregroundStyle(notice.level == "error" ? .red : .orange)
                    }
                    Text(notice.message)
                        .font(.footnote)
                        .lineLimit(3)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
                .onTapGesture { model.dismissToast(notice.id) }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .animation(Motion.reveal, value: model.toasts.map(\.id))
        // Only an error arriving buzzes; a dismissal also changes the ids.
        .sensoryFeedback(trigger: model.toasts.map(\.id)) { old, new in
            let added = Set(new).subtracting(old)
            return model.toasts.contains { added.contains($0.id) && $0.level == "error" } ? .error : nil
        }
    }
}

/// `fullScreenCover(item:)` wants an identity; bytes or a ref are one.
struct ViewedImage: Identifiable {
    let image: MessageImage
    var id: String { image.ref ?? image.data }
}
