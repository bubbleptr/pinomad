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
                        ProgressView("Creating QR code…")
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
            .navigationTitle("Pair a Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
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
            Text("This QR code has expired.")
                .foregroundStyle(.secondary)
            Button("New QR code") {
                Task { await load() }
            }
            .buttonStyle(.tactile(.borderedProminent))
            .controlSize(.large)
        } else {
            if PairingCodeCopy.isLoopback(offer.url) {
                Text("This link only works on the host machine itself; other devices can't open it. To pair a phone, run pinomad pair in a terminal on the host, or create a QR code in Settings → Devices → Pair a device on the web.")
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
                    .accessibilityLabel("Pairing QR code")
            } else {
                Text("Couldn't create a QR code. Copy the link below to the other device instead.")
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
                Label("Copy link", image: .copy)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.bordered))
            .controlSize(.large)

            Text("Expires in \(PairingCodeCopy.countdown(seconds))")
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
            Button("Try again") {
                Task { await load() }
            }
            .buttonStyle(.tactile(.bordered))
            .controlSize(.large)
        } else {
            Text("Connect to the host to create a QR code.")
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
