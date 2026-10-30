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
                case .home:
                    ConversationListView(model: model)
                case .failed(let failure):
                    FailureView(model: model, failure: failure).padding()
                }
            }
            // Connected, the home page has no title: its machine groups say where you are.
            .navigationTitle(model.phase == .home ? "" : "PiNomad")
        }
        .environment(\.popToProviders, PopToProvidersAction(stack: "root") { model.navPath.popToProviders() })
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
        // Focus follows the visible page, not just the selected host.
        .onChange(of: model.navPath) { _, _ in model.navigationChanged() }
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

    /// The home page's shape — where a pairing lands — with what it is
    /// waiting on and the way out at the bottom.
    private var connectingView: some View {
        HomeSkeleton()
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    Text(model.currentHostLabel.map { "Connecting to \($0)…" } ?? "Connecting…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if model.pairingLink != nil {
                        Button("Cancel") { model.cancelPairing() }
                    }
                }
                .padding(.bottom, 16)
            }
    }
}

/// One machine's failure page, pushed from its group or its banner. It
/// steps back by itself once the machine connects again.
struct MachineUnavailableView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            switch model.runtimes[hostKey]?.phase {
            case .failed(let failure)?:
                FailureView(model: model, failure: failure, hostKey: hostKey).padding()
            default:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting to \(model.machineLabel(hostKey))…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
            }
        }
        .navigationTitle(model.machineLabel(hostKey))
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: model.runtimes[hostKey]?.phase) { _, phase in
            if phase == .connected { dismiss() }
        }
    }
}

/// Why the host can't be used, and the ways out that fit: a fresh link,
/// forgetting the host, updating one side, retrying, or another host.
/// `hostKey` is the stored machine a pushed page is about; nil for the
/// whole-screen page of a manual pairing or an unreadable keychain.
private struct FailureView: View {
    let model: AppModel
    let failure: ConnectFailure
    var hostKey: String? = nil

    private var pairing: Bool { hostKey == nil && model.pairingLink != nil }
    private var subjectKey: String? { hostKey ?? model.currentHostKey }

    var body: some View {
        VStack(spacing: 16) {
            Image(.triangleAlert)
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text(failure.title)
                .font(.title2)
                .multilineTextAlignment(.center)
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if case .directUnavailable(let reason) = failure {
                Text("Details: \(reason)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("Change this host's connection mode under Settings → Hosts (ⓘ), then try again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if hostKey == nil, let warning = model.pairingSaveWarning {
                Text(warning)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 10) {
                if canRetry {
                    Button("Try again") {
                        if let hostKey { model.retryConnection(hostKey: hostKey) } else { model.retryConnection() }
                    }
                        .buttonStyle(.tactile(.borderedProminent))
                }
                if failure == .revoked, let key = subjectKey {
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
                if hostKey == nil, let previous = model.previousHostKey {
                    Button("Back to \(model.hostLabels[previous] ?? "the previous host")") { model.switchHost(previous) }
                        .buttonStyle(.tactile(.bordered))
                }
                if hostKey == nil, !pairing {
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
        case .unreachable, .hostOutdated, .directUnavailable: true
        case .pairingRefused, .revoked, .appOutdated: false
        }
    }

    private var detail: String {
        switch failure {
        case .pairingRefused:
            "It was already used or has expired. Run pinomad pair on the host, or create a new link in Settings → Devices → Pair a device."
        case .revoked:
            "It isn't paired with \(hostKey.map(model.machineLabel) ?? model.currentHostLabel ?? "this host"), or its pairing was revoked."
        case .appOutdated(let host, let client):
            "The host uses protocol version \(ConnectFailure.versionText(host)), but this app uses version \(ConnectFailure.versionText(client))."
        case .hostOutdated(let host, let client):
            "This app uses protocol version \(ConnectFailure.versionText(client)), but the host uses version \(ConnectFailure.versionText(host)). Run pinomad upgrade on the host."
        case .directUnavailable:
            "This host can't be reached without the relay, and the peer-to-peer link didn't connect."
        case .unreachable(let message):
            message
        }
    }
}

/// A machine's connection that closed or failed and waits for the reader,
/// above one of its pages. Reconnecting on its own is
/// `reconnectingTitle()`'s, in the bar.
struct ConnectionBanner: View {
    let model: AppModel
    let hostKey: String

    private enum Problem: Equatable { case closed, failed(ConnectFailure) }

    private var problem: Problem? {
        guard let runtime = model.runtimes[hostKey] else { return nil }
        if case .failed(let failure) = runtime.phase { return .failed(failure) }
        return runtime.snapshot?.connection == .closed ? .closed : nil
    }

    var body: some View {
        // The parent animates so the bar slides in and out, not only swaps.
        ZStack {
            switch problem {
            case .closed?:
                bar {
                    Image(.cloudOff)
                    Text("Disconnected")
                    Spacer(minLength: 8)
                    Button("Reconnect") { model.retryConnection(hostKey: hostKey) }
                        .buttonStyle(.tactile(.bordered))
                        .controlSize(.small)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            case .failed(let failure)?:
                bar {
                    Image(.triangleAlert)
                    Text(failure.title).lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Details") { model.navPath.append(.machineUnavailable(hostKey)) }
                        .buttonStyle(.tactile(.bordered))
                        .controlSize(.small)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            case nil:
                EmptyView()
            }
        }
        .animation(Motion.reveal, value: problem)
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

extension View {
    /// "Connecting…" in place of the bar's title while the page's machine
    /// reconnects past its grace window (the messaging apps' spot); the page
    /// itself stays put.
    func reconnectingTitle(_ model: AppModel, hostKey: String?) -> some View {
        toolbar {
            if model.showsReconnecting(hostKey) {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Connecting…")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
            }
        }
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

extension ConnectFailure {
    /// The failure in a few words: the failure page's title and a failed
    /// machine's row.
    var title: String {
        switch self {
        case .pairingRefused: "This pairing code is no longer valid"
        case .revoked: "The host refused or revoked this device"
        case .appOutdated: "Update the app"
        case .hostOutdated: "Update the host"
        case .directUnavailable: "Direct connection unavailable"
        case .unreachable: "Couldn't reach the host"
        }
    }
}

/// `fullScreenCover(item:)` wants an identity; bytes or a ref are one.
struct ViewedImage: Identifiable {
    let image: MessageImage
    var id: String { image.ref ?? image.data }
}
