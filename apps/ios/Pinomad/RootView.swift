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
                    NoHostPage(model: model)
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
            .navigationDestination(for: Route.self) { route in
                RouteDestination(model: model, route: route)
            }
        }
        .environment(\.popToProviders, PopToProvidersAction(stack: "root") { model.navPath.popToProviders() })
        .overlay(alignment: .top) {
            if model.toastHosts.isEmpty { ToastStack(model: model) }
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
            Group {
                switch modal {
                case .settings: SettingsSheet(model: model)
                case .account: AccountView(model: model)
                case .pairingCode: PairingCodeView(model: model)
                case .scanner: ScannerView(model: model)
                case .confirm(let pending): PairConfirmView(model: model, pending: pending)
                }
            }
            .hostsToasts(model)
        }
        .sensoryFeedback(.success, trigger: model.pairings)
        // `pinomad://pair#…` — the confirm page decides what to do with it.
        // `pinomad://auth` is a provider sign-in coming back: it belongs to
        // the browser session that started it, never to pairing.
        .onOpenURL { url in
            guard !NativeOAuth.isCallback(url) else { return }
            model.offerPairing(url.absoluteString)
        }
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
        // A host joined the account from somewhere else (#497). It pairs with
        // this iPhone on its own, so a join the reader didn't make has to be
        // seen; it waits for any sheet to close (the account sheet shows it
        // itself) and stays until dismissed. Remove goes to the account
        // sheet's removal form for that host (#512); with several, to Hosts,
        // where each can be removed.
        .alert("New Host Joined", isPresented: Binding(
            get: { model.newHostNotice != nil && model.modal == nil },
            set: { if !$0 { model.dismissNewHostNotice() } }
        )) {
            // The cancel role, or the destructive button gets a Cancel of its own.
            Button("OK", role: .cancel) { model.dismissNewHostNotice() }
            if model.newHostNotices.count == 1, let host = model.newHostNotices.first {
                Button("Remove from Account", role: .destructive) {
                    model.dismissNewHostNotice()
                    model.pendingHostRemoval = host
                    model.present(.account)
                }
            } else {
                Button("Review Hosts") {
                    model.dismissNewHostNotice()
                    // The home stack holds Settings' Hosts; elsewhere the
                    // account sheet leads there.
                    if model.phase == .home {
                        model.navPath.append(.hosts)
                    } else {
                        model.present(.account)
                    }
                }
            }
        } message: {
            Text((model.newHostNotice ?? "") + "\n\n" + HostLinkCopy.newHostsHint)
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
/// pairing again, updating one side, retrying, or another host.
/// `hostKey` is the stored machine a pushed page is about; nil for the
/// whole-screen page of a manual pairing or an unreadable keychain.
private struct FailureView: View {
    let model: AppModel
    let failure: ConnectFailure
    var hostKey: String? = nil

    private var pairing: Bool { hostKey == nil && model.pairingLink != nil }
    private var subjectKey: String? { hostKey ?? model.currentHostKey }

    var body: some View {
        // A manual pairing keeps its Cancel; the rest get the way back.
        if failure == .revoked, !pairing, let key = subjectKey {
            DeviceRejectedView(model: model, hostKey: key)
        } else {
            failureBody
        }
    }

    private var failureBody: some View {
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
                    .foregroundStyle(.red)
                    .announces(warning)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 10) {
                if canRetry {
                    Button("Try again") {
                        if let hostKey { model.retryConnection(hostKey: hostKey) } else { model.retryConnection() }
                    }
                        .buttonStyle(.tactile(.borderedProminent))
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

/// The host refused this device (4401): it was unpaired there, or its
/// pairing never took. Pairing again comes first — through the account when
/// it can vouch for this host, else a fresh link — and unpairing the dead
/// entry here second. A bare 4401 never removes it on its own (ADR-0032 §6).
private struct DeviceRejectedView: View {
    let model: AppModel
    let hostKey: String

    private var label: String { model.machineLabel(hostKey) }
    private var viaAccount: Bool { model.accountHostId(for: hostKey) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(label) no longer accepts this device")
                    .font(.title2.weight(.semibold))
                Text("This device was unpaired from it, or its pairing was never accepted. Pair again to keep using it.")
                    .foregroundStyle(.secondary)
            }
            if viaAccount {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        model.repairViaAccount(hostKey: hostKey)
                    } label: {
                        Text("Pair again with your account").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glassProminent))
                    .controlSize(.large)
                    .disabled(model.accountBusy)
                    FieldError(message: model.accountError)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(viaAccount ? "Or pair with a link" : "Pair with a link")
                    .font(.headline)
                Text(.init("Run `pinomad pair` on \(label), or open Settings → Devices → Pair a device on a device still paired with it."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                PairingSources(model: model, prominent: !viaAccount)
                    .padding(.top, 4)
            }
            VStack(alignment: .leading, spacing: 4) {
                Button("Unpair \(label)", role: .destructive) { model.unpair(hostKey) }
                if model.accountSession == nil {
                    Button("Sign in to pair through your account") { model.present(.account) }
                }
            }
            .buttonStyle(.borderless)
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A machine's connection that closed or failed and waits for the reader,
/// above one of its pages. Reconnecting on its own is
/// `reconnectingTitle()`'s, in the bar.
struct ConnectionBanner: View {
    let model: AppModel
    let hostKey: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                .transition(Motion.dropIn(reduceMotion: reduceMotion))
            case .failed(let failure)?:
                bar {
                    Image(.triangleAlert)
                    Text(failure.statusTitle).lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Details") { model.navPath.append(.machineUnavailable(hostKey)) }
                        .buttonStyle(.tactile(.bordered))
                        .controlSize(.small)
                }
                .transition(Motion.dropIn(reduceMotion: reduceMotion))
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
                        Text(model.showsRestarting(hostKey) ? "Host is restarting…" : "Connecting…")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
            }
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

    /// The failure as a machine's status, where the rows say how each
    /// machine stands rather than what went wrong.
    var statusTitle: String {
        self == .revoked ? "Not paired" : title
    }
}

/// `fullScreenCover(item:)` wants an identity; bytes or a ref are one.
struct ViewedImage: Identifiable {
    let image: MessageImage
    var id: String { image.ref ?? image.data }
}
