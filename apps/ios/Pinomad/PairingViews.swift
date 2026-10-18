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
                Label("扫描二维码", systemImage: "qrcode.viewfinder")
                    .labelStyle(.titleAndIcon)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            HStack(spacing: 8) {
                TextField("http://…#pair=… 或 pinomad://pair#…", text: $text)
                    .textFieldStyle(.roundedBorder)
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
                .buttonBorderShape(.capsule)
            }
            if invalid {
                Text("不是有效的配对链接——粘贴 `pinomad pair` 打印的完整链接。")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button("继续", action: submit)
                .buttonStyle(.bordered)
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
                Text("连接到宿主")
                    .font(.title2.weight(.semibold))
                Text("在宿主上运行 `pinomad pair`，或在 Web 端打开「设备 → 配对设备」，然后扫码或粘贴链接。")
                    .foregroundStyle(.secondary)
            }
            PairingSources(model: model)
            Text("也可以直接打开 pinomad://pair 链接。")
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
            if let url = pending.url {
                Text("要和这台宿主配对吗？")
                    .font(.title3.weight(.semibold))
                Text("这台设备会和 \(hostOf(url)) 配对。")
                    .foregroundStyle(.secondary)
                Text(url)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                if model.phase == .connected, let current = model.currentHostLabel {
                    Text("会断开当前的 \(current)。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    Button { dismiss() } label: {
                        Text("取消").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        model.pair(link: pending.link)
                        dismiss()
                    } label: {
                        Text("配对").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
                .padding(.top, 8)
            } else {
                Text("这个配对链接无效")
                    .font(.title3.weight(.semibold))
                Text("在宿主上运行 `pinomad pair`，或在「设备 → 配对设备」里生成新的链接。")
                    .foregroundStyle(.secondary)
                Button { dismiss() } label: {
                    Text("好").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
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

/// Every paired host: switch, forget (after a confirm), or pair another.
struct HostsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var forgetting: HostRecord?

    var body: some View {
        NavigationStack {
            List {
                if !model.hosts.hosts.isEmpty {
                    Section("已配对") {
                        ForEach(model.hosts.hosts, id: \.hostKey) { host in
                            row(host)
                        }
                    }
                    // Rows are choices, not links — plain text, not tinted.
                    .tint(.primary)
                }
                Section("再配对一台") {
                    PairingSources(model: model)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            }
            .navigationTitle("宿主")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .alert(
                "忘记 \(forgetting.map(label) ?? "")？",
                isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                presenting: forgetting
            ) { host in
                Button("取消", role: .cancel) {}
                Button("忘记", role: .destructive) { model.forget(host.hostKey) }
            } message: { _ in
                Text("这台设备要用新的配对链接才能再连上它。")
            }
        }
    }

    private func label(_ host: HostRecord) -> String {
        model.hostLabels[host.hostKey] ?? host.url
    }

    private func row(_ host: HostRecord) -> some View {
        Button {
            model.switchHost(host.hostKey)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label(host))
                        .foregroundStyle(.primary)
                    Text(host.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if host.hostKey == model.currentHostKey {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.blue)
                }
            }
        }
        .swipeActions {
            Button("忘记", role: .destructive) { forgetting = host }
        }
        .contextMenu {
            Button("忘记", systemImage: "trash", role: .destructive) { forgetting = host }
        }
    }
}
