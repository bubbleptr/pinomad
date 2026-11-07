import AgentChatCore
import SwiftUI

/// The todo list at the end of the newest run, folded to one line: how far
/// along it is, the item being worked on, and when any run last wrote it —
/// the agent may have planned at the start and never updated it since. A
/// tap unfolds the whole list in place; the trace sheet stays the run's
/// steps only.
public struct TodoLineView: View {
    let line: TodoLine
    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ line: TodoLine) {
        self.line = line
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { isExpanded.toggle() }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint(isExpanded
                ? String(localized: "Hides the steps", bundle: .module)
                : String(localized: "Shows the steps", bundle: .module))
            if isExpanded {
                items
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.separator))
    }

    private var header: some View {
        let list = line.list
        return HStack(spacing: 8) {
            if isExpanded {
                Text("Todo", bundle: .module)
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                Text(verbatim: "\(list.completedCount)/\(list.items.count)")
                    .monospacedDigit()
            } else if list.isFinished {
                TodoStatusMark(status: .completed)
                Text("Todo \(list.completedCount)/\(list.items.count)", bundle: .module)
                    .monospacedDigit()
            } else {
                if let current = list.current {
                    TodoStatusMark(status: current.status)
                }
                Text(verbatim: "\(list.completedCount)/\(list.items.count)")
                    .monospacedDigit()
                if let current = list.current {
                    Text(current.text)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 0)
            if let writtenAt = line.writtenAt {
                TimelineView(.everyMinute) { context in
                    let age = TodoText.age(of: writtenAt, now: context.date)
                    Group {
                        if isExpanded {
                            Text("Updated \(age)", bundle: .module)
                        } else {
                            Text(verbatim: age)
                        }
                    }
                    .foregroundStyle(.tertiary)
                    .fixedSize()
                }
            }
            Image(Icon.chevronRight)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private var items: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(line.list.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    TodoStatusMark(status: item.status)
                    Text(item.text)
                        .strikethrough(item.status == .completed)
                        .foregroundStyle(item.status == .completed ? .secondary : .primary)
                        .fontWeight(item.status == .inProgress ? .medium : .regular)
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
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
