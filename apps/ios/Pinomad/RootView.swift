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
                    ProgressView("正在启动…")
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
            .navigationTitle("PiNomad")
        }
        .overlay(alignment: .top) {
            if !model.sheetShowsToasts { ToastStack(model: model) }
        }
        // Above every page — conversations and the draft both stage and
        // show images — so a tap anywhere opens here and nothing lingers.
        .fullScreenCover(item: Binding(
            get: { model.viewing.map(ViewedImage.init) },
            set: { model.viewing = $0?.image }
        )) { viewed in
            ImageViewer(image: viewed.image) { model.viewing = nil }
                .presentationBackground(.clear)
        }
        .sheet(item: $model.modal, onDismiss: model.modalDismissed) { modal in
            switch modal {
            case .hosts: HostsView(model: model)
            case .account: AccountLoginView(model: model)
            case .pairingCode: PairingCodeView(model: model)
            case .scanner: ScannerView(model: model)
            case .confirm(let pending): PairConfirmView(model: model, pending: pending)
            }
        }
        // `pinomad://pair#…` — the confirm page decides what to do with it.
        .onOpenURL { url in model.offerPairing(url.absoluteString) }
        // Forgetting could not clear the host-side registration; the only
        // remaining path is revoking this device from the host.
        .alert("推送登记没注销", isPresented: Binding(
            get: { model.pushForgetWarning != nil },
            set: { if !$0 { model.pushForgetWarning = nil } }
        )) {
            Button("好") { model.pushForgetWarning = nil }
        } message: {
            Text(model.pushForgetWarning ?? "")
        }
    }

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView(model.currentHostLabel.map { "正在连接 \($0)…" } ?? "正在连接…")
            if model.pairingLink != nil {
                Button("取消") { model.cancelPairing() }
            } else if model.hosts.hosts.count > 1 {
                Button("换一台宿主") { model.present(.hosts) }
            }
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
            Image(systemName: "exclamationmark.triangle.fill")
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
                    Button("重试") { model.retryConnection() }
                        .buttonStyle(.borderedProminent)
                }
                if failure == .revoked, let key = model.currentHostKey {
                    if model.accountHostId(for: key) != nil {
                        Button("经账号重新配对") { model.repairViaAccount(hostKey: key) }
                            .buttonStyle(.bordered)
                            .disabled(model.accountBusy)
                    }
                    Button("忘记这台宿主", role: .destructive) { model.forget(key) }
                        .buttonStyle(.bordered)
                }
                if pairing {
                    Button("取消") { model.cancelPairing() }
                        .buttonStyle(.bordered)
                } else if let previous = model.previousHostKey {
                    Button("回到 \(model.hostLabels[previous] ?? "之前的宿主")") { model.switchHost(previous) }
                        .buttonStyle(.bordered)
                }
                if !pairing, !model.hosts.hosts.isEmpty {
                    Button("宿主") { model.present(.hosts) }
                        .buttonStyle(.bordered)
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
        case .pairingRefused: "这个配对码已失效"
        case .revoked: "这台设备被宿主拒绝或吊销了"
        case .appOutdated: "请更新 App"
        case .hostOutdated: "请升级宿主"
        case .unreachable: "连不上宿主"
        }
    }

    private var detail: String {
        switch failure {
        case .pairingRefused:
            "它已经用过或过期了。在宿主上运行 pinomad pair，或在「设备 → 配对设备」里生成新的链接。"
        case .revoked:
            "它没有和\(model.currentHostLabel ?? "这台宿主")配对，或配对已被撤销。"
        case .appOutdated(let host, let client):
            "宿主使用协议 \(ConnectFailure.versionText(host)) 版，这个 App 是 \(ConnectFailure.versionText(client)) 版。"
        case .hostOutdated(let host, let client):
            "这个 App 使用协议 \(ConnectFailure.versionText(client)) 版，宿主是 \(ConnectFailure.versionText(host)) 版。在宿主上运行 pinomad upgrade。"
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
        if let connection = model.snapshot?.connection, model.phase == .connected {
            switch connection {
            case .reconnecting:
                bar {
                    ProgressView().controlSize(.small)
                    Text("重连中…")
                }
            case .closed:
                bar {
                    Image(systemName: "bolt.horizontal.circle")
                    Text("已断开")
                    Spacer(minLength: 8)
                    Button("重连") { model.retryConnection() }
                        .buttonStyle(.bordered)
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
                        Image(systemName: "exclamationmark.circle.fill")
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
        .animation(.snappy, value: model.toasts.map(\.id))
    }
}

/// `fullScreenCover(item:)` wants an identity; an image's bytes are one.
private struct ViewedImage: Identifiable {
    let image: MessageImage
    var id: String { image.data }
}
