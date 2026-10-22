import AgentChatCore
import SwiftUI

/// The todo list folded to one line at the end of the newest run: how far
/// along it is, the item being worked on, and when any run last wrote it —
/// the agent may have planned at the start and never updated it since.
/// `onOpen` is for presenting the same sheet the capsule opens.
public struct TodoLineView: View {
    let line: TodoLine
    let onOpen: () -> Void

    public init(_ line: TodoLine, onOpen: @escaping () -> Void) {
        self.line = line
        self.onOpen = onOpen
    }

    public var body: some View {
        let list = line.list
        Button(action: onOpen) {
            HStack(spacing: 6) {
                if list.isFinished {
                    TodoStatusMark(status: .completed)
                    Text("Todo \(list.completedCount)/\(list.items.count)", bundle: .module)
                        .monospacedDigit()
                } else {
                    Text(verbatim: "\(list.completedCount)/\(list.items.count)")
                        .monospacedDigit()
                    if let current = list.current {
                        TodoStatusMark(status: current.status)
                        Text(current.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                if let writtenAt = line.writtenAt {
                    TimelineView(.everyMinute) { context in
                        Text(verbatim: "· " + TodoText.age(of: writtenAt, now: context.date))
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(String(localized: "Shows the steps", bundle: .module))
    }
}

/// The whole list, at the top of the trace sheet.
struct TodoListView: View {
    let line: TodoLine

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Todo", bundle: .module)
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: "\(line.list.completedCount)/\(line.list.items.count)")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                if let writtenAt = line.writtenAt {
                    TimelineView(.everyMinute) { context in
                        Text("Updated \(TodoText.age(of: writtenAt, now: context.date))", bundle: .module)
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            ForEach(Array(line.list.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    TodoStatusMark(status: item.status)
                        .font(.callout)
                    Text(item.text)
                        .font(.callout)
                        .strikethrough(item.status == .completed)
                        .foregroundStyle(item.status == .completed ? .secondary : .primary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 12))
    }
}

enum TodoText {
    /// "6m ago"; a write within the minute is "this minute", and a host
    /// clock ahead of the phone's is not a write from the future.
    static func age(of writtenAt: Date, now: Date) -> String {
        min(writtenAt, now).formatted(
            Date.RelativeFormatStyle(
                allowedFields: [.year, .month, .week, .day, .hour, .minute],
                presentation: .named,
                unitsStyle: .narrow
            )
        )
    }
}
