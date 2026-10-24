import PinomadChat
import SwiftUI

/// One staged file in the composer: name, progress (or Failed), retry and
/// remove — the same compact language as the Web chips.
struct FileAttachmentChip: View {
    let entry: FileAttachmentTray.Entry
    let retry: () -> Void
    let remove: () -> Void

    private var status: String {
        switch entry.status {
        case .uploading: "\(attachmentPercent(received: entry.received, size: entry.size))%"
        case .failed: "Failed"
        case .done: formatFileSize(entry.size)
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(.file)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.caption)
                    .lineLimit(1)
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(entry.status == .failed ? .red : .secondary)
                if entry.status == .uploading {
                    ProgressView(value: Double(entry.received), total: Double(max(entry.size, 1)))
                        .progressViewStyle(.linear)
                        .tint(.secondary)
                        .frame(height: 2)
                }
            }
            if entry.status == .failed {
                Button(action: retry) {
                    Image(.rotateCw)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.press)
                .accessibilityLabel("Retry \(entry.name)")
            }
            Button(action: remove) {
                Image(.x)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.press)
            .accessibilityLabel("Remove \(entry.name)")
        }
        .padding(.leading, 9)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .frame(maxWidth: 230)
        .background(.fill.tertiary, in: .rect(cornerRadius: 10))
        .accessibilityHint(entry.error ?? entry.name)
    }
}

/// A file in a sent message: name and size, never a preview.
struct SentFileChip: View {
    let name: String
    let size: Int

    var body: some View {
        HStack(spacing: 6) {
            Image(.file)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text(name)
                .font(.caption)
                .lineLimit(1)
            Text(formatFileSize(size))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .frame(maxWidth: 230)
        .background(.fill.tertiary, in: .rect(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}
