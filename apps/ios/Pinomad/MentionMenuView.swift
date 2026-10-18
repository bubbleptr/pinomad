import PinomadChat
import PinomadCore
import SwiftUI

/// Owns the composer's @ menu across body updates: the caret selection,
/// the pure menu state, and the debounced file query. One per composer so
/// switching pages or hosts drops whatever was in flight.
@MainActor @Observable
final class MentionCoordinator {
    var menu = MentionMenu()
    var selection: TextSelection?
    private var task: Task<Void, Never>?

    /// Recompute from the draft and caret; a new query replaces the old
    /// debounce, and the pure menu drops answers for anything older.
    func refresh(
        text: String,
        roles: [AgentRole],
        scope: FileScope?,
        load: @escaping @MainActor (FileScope, String) async throws -> (files: [String], truncated: Bool)
    ) {
        guard let cursor = selection?.caret(in: text) else {
            close()
            return
        }
        guard let request = menu.refresh(
            text: text, cursor: cursor, roles: roles, scope: scope)
        else { return }
        task?.cancel()
        task = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self, !Task.isCancelled else { return }
            do {
                let result = try await load(request.scope, request.query)
                guard !Task.isCancelled else { return }
                menu.receive(request, files: result.files, truncated: result.truncated)
            } catch {
                // Cancellation means a newer query owns the menu now.
                guard !Task.isCancelled else { return }
                menu.fail(request)
            }
        }
    }

    func close() {
        task?.cancel()
        task = nil
        menu.dismiss()
    }

    /// Replace the token with plain text and hand back the new draft plus
    /// the caret after it. The field applies both in one update.
    func insert(_ choice: MentionChoice, into text: String) -> MentionInsertion? {
        guard let token = menu.token else { return nil }
        let insertion = token.replacing(in: text, with: choice.insertion)
        close()
        return insertion
    }
}

extension TextSelection {
    /// The caret's UTF-16 offset in text; nil for a range selection, a
    /// non-collapsed insertion, or an index the field already replaced.
    func caret(in text: String) -> Int? {
        guard isInsertion, case .selection(let range) = indices, range.isEmpty else { return nil }
        guard range.lowerBound <= text.endIndex else { return nil }
        return range.lowerBound.utf16Offset(in: text)
    }
}

/// The @ menu sitting directly above a composer card: local agent roles
/// first, then the host's file candidates. Every row inserts plain text;
/// the host never parses a mention token.
struct MentionMenuView: View {
    let menu: MentionMenu
    let choose: (MentionChoice) -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var rowCount: Int {
        menu.agents.count + menu.files.count + (menu.filesTruncated ? 1 : 0)
            + (showsLoading ? 1 : 0) + (showsDivider ? 1 : 0)
    }

    private var showsLoading: Bool {
        menu.filesLoading && menu.agents.isEmpty && menu.files.isEmpty
    }

    private var showsDivider: Bool {
        !menu.agents.isEmpty && (!menu.files.isEmpty || menu.filesLoading)
    }

    var body: some View {
        Group {
            if rowCount > 6 {
                ScrollView {
                    rows
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.hidden)
                // About six rows; the rest scrolls.
                .frame(height: 292)
            } else {
                rows
            }
        }
        .padding(.vertical, 4)
        .clipShape(.rect(cornerRadius: 22))
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        // The material does not pick up a system appearance switch while a
        // short menu is already on screen; a new identity re-resolves it.
        .id(colorScheme)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private var rows: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(menu.agents, id: \.name) { role in
                Button {
                    choose(.agent(role.name))
                } label: {
                    AgentMentionRow(role: role)
                }
                .buttonStyle(MentionRowStyle())
            }
            if showsDivider {
                Divider()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 3)
            }
            ForEach(menu.files, id: \.self) { path in
                Button {
                    choose(.file(path))
                } label: {
                    FileMentionRow(path: path)
                }
                .buttonStyle(MentionRowStyle())
            }
            if menu.filesTruncated {
                Text("继续输入以缩小范围")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
            if showsLoading {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("正在查找文件…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
        }
    }
}

private struct AgentMentionRow: View {
    let role: AgentRole

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 17))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("@\(role.name)")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if !role.description.isEmpty {
                    Text(role.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(.rect)
    }
}

private struct FileMentionRow: View {
    let path: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.subheadline)
                    .lineLimit(1)
                Text(folder)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(.rect)
    }

    private var name: String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    private var folder: String {
        guard let slash = path.lastIndex(of: "/") else { return "./" }
        return String(path[..<slash]) + "/"
    }
}

/// The pressed state the plain buttons otherwise lose inside the glass.
private struct MentionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.primary.opacity(0.07) : Color.clear)
    }
}
