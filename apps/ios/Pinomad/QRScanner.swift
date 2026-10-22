import AVFoundation
import PinomadCore
import SwiftUI
import VisionKit

/// Scans the host's pairing QR code. Camera access is the only permission
/// it needs; the first code that is a pairing link goes to the confirm
/// page, anything else just says it isn't one.
struct ScannerView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var rejected = false
    /// A code stays in view for several frames — only the first good one
    /// moves on.
    @State private var handled = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("扫描二维码")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }
                    }
                }
        }
        .task {
            if access == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
                access = AVCaptureDevice.authorizationStatus(for: .video)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch access {
        case .authorized:
            if DataScannerViewController.isSupported {
                QRCodeScanner { payload in found(payload) }
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .bottom) {
                        if rejected {
                            Text("不是 PiNomad 的配对码")
                                .font(.footnote)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .glassEffect(.regular, in: .capsule)
                                .padding(.bottom, 40)
                        }
                    }
            } else {
                ContentUnavailableView(
                    "这台设备不能扫码", systemImage: "camera",
                    description: Text("改为粘贴配对链接。"))
            }
        case .notDetermined:
            ProgressView()
        default:
            ContentUnavailableView {
                Label("需要相机权限", systemImage: "camera")
            } description: {
                Text("PiNomad 只用相机扫描宿主的配对二维码和拍照。")
            } actions: {
                Button("打开设置") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
                .buttonStyle(.tactile(.borderedProminent))
            }
        }
    }

    private func found(_ payload: String) {
        guard !handled else { return }
        guard model.isPairingLink(payload) else {
            rejected = true
            return
        }
        handled = true
        // `present` closes this sheet first, then shows the confirm page.
        model.offerPairing(payload)
    }
}

/// VisionKit's live scanner, QR codes only; reports each recognised
/// payload once per appearance in view.
private struct QRCodeScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onPayload = onPayload
        // Scanning can only start once the camera is up and the view is
        // in a window — the first update is the earliest point.
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onPayload: (String) -> Void

        init(onPayload: @escaping (String) -> Void) { self.onPayload = onPayload }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                if let payload = code.payloadStringValue { onPayload(payload) }
            }
        }
    }
}
