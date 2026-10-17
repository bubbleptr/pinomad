import PinomadChat
import PinomadCore
import SwiftUI

/// The shown conversation's input: run status and queued inputs above a
/// glass card holding the draft and its actions. Sits in the transcript's
/// bottom safe-area inset, so the keyboard and the scroll inset follow it.
struct ConversationComposer: View {
    let model: AppModel
    let conversation: ConversationSnapshot

    @State private var showModels = false
    @FocusState private var focused: Bool

    private var connected: Bool {
        guard let snapshot = model.snapshot else { return false }
        return snapshot.connection == .connected && !snapshot.unauthorized
    }

    private var draft: Binding<String> {
        Binding(
            get: { model.drafts[conversation.id] ?? "" },
            set: { model.drafts[conversation.id] = $0 }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !conversation.statusText.isEmpty {
                StatusPill(text: conversation.statusText)
            }
            if !conversation.queueItems.isEmpty {
                QueueList(items: conversation.queueItems)
            }
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .sheet(isPresented: $showModels) {
            ModelSheet(model: model, agent: conversation.agent)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(
                conversation.busy ? "追加指令…" : "问点什么…",
                text: draft, axis: .vertical
            )
            .lineLimit(1...6)
            .focused($focused)
            .disabled(!connected)
            .onChange(of: focused) { _, isFocused in
                // Let the keyboard's inset land first, then show the end.
                guard isFocused else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    model.transcriptPin += 1
                }
            }
            HStack(spacing: 10) {
                PlusMenu(connected: connected) { model.compact() }
                ModelCapsule(
                    label: modelText,
                    enabled: connected && !(model.snapshot?.models.isEmpty ?? true)
                ) {
                    focused = false
                    showModels = true
                }
                Spacer(minLength: 0)
                sendSlot
            }
            .frame(minHeight: 34)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
    }

    private var modelText: String {
        let agent = conversation.agent
        return modelLabel(
            models: model.snapshot?.models ?? [],
            selected: ModelPick(model: agent.model, level: agent.thinkingLevel ?? .off)
        )
    }

    @ViewBuilder
    private var sendSlot: some View {
        switch SendSlot(draft: draft.wrappedValue, connected: connected, busy: conversation.busy) {
        case .hidden:
            EmptyView()
        case .stop(let enabled):
            Button {
                model.stop(conversation: conversation.id)
            } label: {
                SlotIcon(systemName: "stop.fill")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("停止")
            .disabled(!enabled)
        case .send(let enabled, let canSteer):
            if canSteer {
                // Tap queues a follow-up; the long-press menu can steer
                // the running turn instead.
                Menu {
                    Button("引导当前运行（Steer）", systemImage: "arrow.uturn.right") {
                        model.send(conversation: conversation.id, mode: .steer)
                    }
                    Button("运行完再发（Follow-up）", systemImage: "text.append") {
                        model.send(conversation: conversation.id, mode: .followUp)
                    }
                } label: {
                    SlotIcon(systemName: "arrow.up")
                } primaryAction: {
                    model.send(conversation: conversation.id, mode: .followUp)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
                .accessibilityHint("运行结束后发送；长按可改为立即引导")
                .disabled(!enabled)
            } else {
                Button {
                    model.send(conversation: conversation.id, mode: .followUp)
                } label: {
                    SlotIcon(systemName: "arrow.up")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
                .disabled(!enabled)
            }
        }
    }
}

/// The filled circle the trailing slot shows for send and stop.
private struct SlotIcon: View {
    let systemName: String
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .bold))
            // Concrete colors: on glass the hierarchical `.primary` gets
            // vibrancy and reads as a disabled grey.
            .foregroundStyle(Color(uiColor: .systemBackground))
            .frame(width: 34, height: 34)
            .background(Color(uiColor: isEnabled ? .label : .tertiaryLabel), in: .circle)
    }
}

private struct PlusMenu: View {
    let connected: Bool
    let compact: () -> Void

    var body: some View {
        Menu {
            Button("压缩上下文", systemImage: "rectangle.compress.vertical", action: compact)
                .disabled(!connected)
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 34, height: 34)
                .background(.fill.tertiary, in: .circle)
        }
        .tint(.secondary)
        .accessibilityLabel("更多操作")
    }
}

private struct ModelCapsule: View {
    let label: String
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label.isEmpty ? "选择模型" : label)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(.fill.tertiary, in: .capsule)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel("模型：\(label)")
    }
}

private struct StatusPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
    }
}

/// Inputs waiting on the run, oldest first; scrolls past about three.
private struct QueueList: View {
    let items: [QueueItem]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 8) {
                        Text(tag(item.mode))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(item.text.isEmpty ? " " : item.text)
                            .font(.footnote)
                            .lineLimit(1)
                        if item.imageCount > 0 {
                            Text("· \(item.imageCount) 张图片")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14))
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollClipDisabled()
        // A ScrollView takes all the height it's offered; size it to the
        // rows (~38pt each) up to three.
        .frame(height: min(CGFloat(items.count) * 38, 112))
    }

    private func tag(_ mode: QueueMode) -> String {
        switch mode {
        case .steer: "引导"
        case .followUp: "追加"
        case .write, .other: "排队"
        }
    }
}
