import PinomadCore
import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack(path: $model.navPath) {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("正在启动…")
                case .pairing:
                    pairingView.padding()
                case .connecting:
                    ProgressView(model.connectionText.isEmpty ? "正在连接…" : model.connectionText)
                case .connected:
                    ConversationListView(model: model)
                case .failed(let message):
                    failedView(message).padding()
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
    }

    private var pairingView: some View {
        VStack(spacing: 20) {
            Text("粘贴配对链接，把这台设备连到你的 PiNomad 宿主。")
                .foregroundStyle(.secondary)
            TextField("pinomad:// 或 https://…#pair=…", text: $model.link)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            PasteButton(supportedContentTypes: [.plainText, .url]) { providers in
                guard let provider = providers.first else { return }
                _ = provider.loadObject(ofClass: String.self) { text, _ in
                    if let text {
                        Task { @MainActor in model.link = text }
                    }
                }
            }
            Button("连接") { model.pair() }
                .buttonStyle(.borderedProminent)
                .disabled(model.link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text("连接失败")
                .font(.title2)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 16) {
                Button("重试") { model.retry() }
                    .buttonStyle(.bordered)
                Button("重新配对") { model.phase = .pairing }
                    .buttonStyle(.borderedProminent)
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
