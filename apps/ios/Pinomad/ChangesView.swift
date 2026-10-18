import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

/// The conversation's changes sheet: the file list the host derived from
/// the checkout's diff, with a pushed diff page per file. The state rules
/// live in `PinomadChat.ChangesPanel`; this view only supplies fetches,
/// busy snapshots, and the sheet's lifetime.
struct ChangesSheet: View {
    let model: AppModel
    let conversationId: UInt64

    @Environment(\.dismiss) private var dismiss
    @State private var panel = ChangesPanel()

    private var conversation: ConversationSnapshot? {
        model.snapshot?.conversation.flatMap { $0.id == conversationId ? $0 : nil }
    }

    private var busy: Bool { conversation?.busy ?? false }
    private var checkout: WorktreeCheckout? { conversation?.checkout }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("改动")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel("关闭")
                    }
                }
                .navigationDestination(for: PatchFile.self) { file in
                    FileDiffView(file: file)
                }
        }
        .task { await open() }
        // The Web dialog refreshes once when a run settles; any other busy
        // change (or an unchanged false) is not new work to look at.
        .onChange(of: busy) { _, next in
            guard let token = panel.observe(busy: next) else { return }
            Task { await load(token) }
        }
        // Attached to the stack, not its content: pushing a file page must
        // not end the sheet's epoch, while dismissing the sheet must.
        .onDisappear { panel.close() }
    }

    @ViewBuilder
    private var content: some View {
        if panel.loading && panel.changes == nil {
            ProgressView("正在读取改动…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let changes = panel.changes {
            loaded(changes)
        } else if let error = panel.error {
            failure(error)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func loaded(_ changes: ConversationChanges) -> some View {
        switch changes {
        case .unavailable(let reason):
            emptyState(
                title: "没有可显示的改动",
                systemImage: "doc.text.magnifyingglass",
                description: reason
            )
        case .available(let base, let files, let truncated):
            if files.isEmpty {
                emptyState(
                    title: "还没有改动",
                    systemImage: "checkmark.circle",
                    description: "这个对话还没有改动任何文件。"
                )
            } else {
                fileList(base: base, files: files, truncated: truncated)
            }
        }
    }

    /// Pull-to-refresh works in every non-list state too — especially the
    /// unavailable reason, which can change as soon as the agent starts a
    /// task in a checkout.
    private func emptyState(title: String, systemImage: String, description: String) -> some View {
        ScrollView {
            VStack(spacing: 8) {
                if panel.loading || panel.error != nil {
                    VStack(alignment: .leading, spacing: 6) {
                        refreshIndicator
                        refreshFailure
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                ContentUnavailableView {
                    Label(title, systemImage: systemImage)
                } description: {
                    Text(description)
                }
                .frame(maxWidth: .infinity, minHeight: 420)
            }
        }
        .refreshable { await refresh() }
    }

    private func failure(_ message: String) -> some View {
        ScrollView {
            ContentUnavailableView {
                Label("无法读取改动", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("重试") {
                    Task { await refresh() }
                }
                .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity, minHeight: 420)
        }
        .refreshable { await refresh() }
    }

    private func fileList(base: String, files: [PatchFile], truncated: Bool) -> some View {
        let additions = files.reduce(UInt64(0)) { $0 + $1.additions }
        let deletions = files.reduce(UInt64(0)) { $0 + $1.deletions }

        return List {
            if panel.error != nil {
                Section {
                    refreshFailure
                }
            }
            Section {
                ForEach(files.indices, id: \.self) { index in
                    NavigationLink(value: files[index]) {
                        FileRow(file: files[index])
                    }
                }
            } header: {
                VStack(alignment: .leading, spacing: 5) {
                    refreshIndicator
                    if checkout == nil {
                        Text("这是项目目录里未提交的改动，不只是这个对话做的")
                    } else {
                        Text("相对 worktree 起点 \(String(base.prefix(7)))")
                    }
                    if truncated {
                        Text("改动太大，只显示了前 1 MB")
                    }
                    Text("\(files.count) 个文件，+\(additions) −\(deletions)")
                        .monospacedDigit()
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textCase(nil)
                .padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .refreshable { await refresh() }
    }

    private func open() async {
        let token = panel.open(busy: busy)
        await load(token)
    }

    private func refresh() async {
        guard let token = panel.refresh() else { return }
        await load(token)
    }

    private func load(_ token: ChangesPanel.Token) async {
        do {
            let changes = try await model.changes(conversation: conversationId)
            panel.land(token, changes)
        } catch is CancellationError {
            // The sheet is going away; `close()` already ended the epoch.
        } catch {
            panel.fail(token, model.describe(error))
        }
    }

    /// A failed refresh keeps the last good result; this banner is how that
    /// state still says why it is stale (the file list, unavailable reason,
    /// and empty state all render it).
    @ViewBuilder
    private var refreshFailure: some View {
        if let error = panel.error {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Spacer(minLength: 8)
                Button("重试") {
                    Task { await refresh() }
                }
                .font(.footnote)
            }
        }
    }

    /// A refresh over an existing result keeps that result on screen; this
    /// small line is the only loading signal in the empty/unavailable states.
    @ViewBuilder
    private var refreshIndicator: some View {
        if panel.loading {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text("刷新中…")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}

/// One file in the changes list: its path (renames show the old path
/// above the new one), status tags, and the two diff counts.
private struct FileRow: View {
    let file: PatchFile

    private var renamed: Bool {
        file.oldPath.map { $0 != file.path } ?? false
    }

    private var hasBadge: Bool {
        file.isNew || file.isDeleted || renamed || file.binary
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                pathLabel
                    .font(.system(.footnote, design: .monospaced))
                if hasBadge {
                    HStack(spacing: 4) {
                        if file.isNew {
                            FileBadge("新增", color: .green)
                        }
                        if file.isDeleted {
                            FileBadge("删除", color: .red)
                        }
                        if renamed {
                            FileBadge("重命名", color: .blue)
                        }
                        if file.binary {
                            FileBadge("二进制", color: .gray)
                        }
                    }
                }
            }
            .layoutPriority(1)

            Spacer(minLength: 4)

            HStack(spacing: 3) {
                Text("+\(file.additions)")
                    .foregroundStyle(.green)
                Text("−\(file.deletions)")
                    .foregroundStyle(.red)
            }
            .font(.caption.monospacedDigit())
            .fixedSize()
        }
        .padding(.vertical, 2)
    }

    /// A rename keeps the arrow between two independently truncated paths —
    /// middle-truncating one long `old → new` string can eat the arrow.
    @ViewBuilder
    private var pathLabel: some View {
        if let old = file.oldPath, old != file.path {
            VStack(alignment: .leading, spacing: 1) {
                Text(old)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    Image(systemName: "arrow.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(file.path)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        } else {
            Text(file.path)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

private struct FileBadge: View {
    let text: String
    let color: Color

    init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.14), in: Capsule())
    }
}

/// One file's diff. The vertical and horizontal scroll views are nested
/// once for the whole block — every line shares one horizontal offset, so
/// a long line does not scroll by itself. `LazyVStack` keeps a huge diff
/// cheap to scroll, and selection is enabled for copying text out.
struct FileDiffView: View {
    let file: PatchFile

    private var fileName: String {
        (file.path as NSString).lastPathComponent
    }

    var body: some View {
        Group {
            if file.binary {
                ContentUnavailableView("二进制文件，不显示内容", systemImage: "doc")
            } else if file.lines.isEmpty {
                ContentUnavailableView("没有可显示的内容", systemImage: "doc.text")
            } else {
                diff
            }
        }
        .navigationTitle(fileName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var diff: some View {
        GeometryReader { proxy in
            // One fixed width for every row: the block is as wide as its
            // longest line (or the viewport), so add/del backgrounds run
            // the full row while the whole block scrolls as one.
            let width = max(proxy.size.width, lineWidth)
            ScrollView(.vertical) {
                ScrollView(.horizontal) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(file.lines.indices, id: \.self) { index in
                            DiffLineRow(line: file.lines[index], width: width)
                        }
                    }
                    .textSelection(.enabled)
                    .padding(.vertical, 6)
                    .frame(width: width, alignment: .leading)
                }
            }
        }
    }

    /// ASCII in a monospaced font is exactly one advance per character;
    /// everything else is measured because emoji and CJK can be wider than
    /// one cell. An underestimate would clip the end of the scroll range.
    private var lineWidth: CGFloat {
        let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        let advance = ("M" as NSString).size(withAttributes: attributes).width
        let widest = file.lines.reduce(CGFloat.zero) { width, line in
            let text = line.text
            if text.allSatisfy(\.isASCII) && !text.contains("\t") {
                return max(width, CGFloat(text.count) * advance)
            }
            return max(width, (text as NSString).size(withAttributes: attributes).width)
        }
        return widest + 28
    }
}

private struct DiffLineRow: View {
    let line: PatchLine
    let width: CGFloat

    var body: some View {
        Text(line.text.isEmpty ? " " : line.text)
            .font(Font(UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)))
            .foregroundStyle(foreground)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 10)
            .padding(.vertical, 1)
            .frame(width: width, alignment: .leading)
            .background(background)
    }

    private var foreground: Color {
        line.kind == .meta ? .secondary : .primary
    }

    private var background: Color {
        switch line.kind {
        case .add: .green.opacity(0.16)
        case .del: .red.opacity(0.16)
        case .meta: .secondary.opacity(0.07)
        case .ctx: .clear
        }
    }
}
