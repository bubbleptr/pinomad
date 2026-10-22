import CoreImage
import CoreImage.CIFilterBuiltins
import PinomadCore
import SwiftUI
import UIKit

/// The current host's one-time pairing offer (ADR-0022 §7): a QR code, the
/// copyable link, and a countdown. A 127.0.0.1 link only reaches the host
/// machine itself, so it shows the hint instead of an unscannable code.
struct PairingCodeView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var offer: PairingCodeOffer?
    @State private var qrImage: UIImage?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if loading {
                        ProgressView("正在生成二维码…")
                            .padding(.top, 40)
                    } else if let offer {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            offerContent(offer, now: context.date)
                        }
                    } else {
                        unavailable
                    }
                }
                .padding(20)
            }
            .navigationTitle("给另一台设备配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task { await load() }
            .presentationDetents([.large])
        }
    }

    @ViewBuilder
    private func offerContent(_ offer: PairingCodeOffer, now: Date) -> some View {
        let seconds = PairingCodeCopy.remainingSeconds(expiresAt: offer.expiresAt, now: now)
        if seconds == 0 {
            Text("二维码已过期。")
                .foregroundStyle(.secondary)
            Button("新二维码") {
                Task { await load() }
            }
            .buttonStyle(.tactile(.borderedProminent))
            .controlSize(.large)
        } else {
            if PairingCodeCopy.isLoopback(offer.url) {
                Text("这个链接只在宿主这台机器上有效，另一台设备打不开。要配对手机，请用宿主终端的 pinomad pair，或在 Web 端「设备 → 配对设备」里生成二维码。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else if let qrImage {
                Image(uiImage: qrImage)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .padding(20)
                    .background(.white, in: .rect(cornerRadius: 16))
                    .accessibilityLabel("配对二维码")
            } else {
                Text("没能生成二维码，可以把下面的链接复制给对方。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            Text(offer.url)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.fill.tertiary, in: .rect(cornerRadius: 10))

            Button {
                UIPasteboard.general.string = offer.url
            } label: {
                Label("复制链接", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.bordered))
            .controlSize(.large)

            Text("有效期还剩 \(PairingCodeCopy.countdown(seconds))")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var unavailable: some View {
        if let error {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
            Button("重试") {
                Task { await load() }
            }
            .buttonStyle(.tactile(.bordered))
            .controlSize(.large)
        } else {
            Text("连上宿主后才能生成二维码。")
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        loading = true
        error = nil
        offer = nil
        qrImage = nil
        let result = await model.createPairingOffer()
        loading = false
        switch result {
        case .success(let value):
            offer = value
            if !PairingCodeCopy.isLoopback(value.url) {
                qrImage = QRCodeImage.make(value.url)
            }
        case .failure(let failure):
            error = failure.message
        }
    }
}

/// CoreImage's built-in QR generator; no extra dependency.
@MainActor
private enum QRCodeImage {
    static func make(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        guard let cgImage = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
