import PinomadCore
import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("正在启动…")
                case .pairing:
                    pairingView
                case .connecting:
                    ProgressView(model.connectionText.isEmpty ? "正在连接…" : model.connectionText)
                case .connected:
                    connectedView
                case .failed(let message):
                    failedView(message)
                }
            }
            .padding()
            .navigationTitle("PiNomad")
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

    private var connectedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
            Text("已连接")
                .font(.title2)
            if !model.hostURL.isEmpty {
                Text(model.hostURL)
                    .foregroundStyle(.secondary)
                    .font(.callout)
            }
            LabeledContent("连接状态", value: model.connectionText)
            LabeledContent("对话数", value: "\(model.conversationCount)")
            if !model.lastError.isEmpty {
                Text(model.lastError)
                    .foregroundStyle(.orange)
                    .font(.footnote)
            }
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
