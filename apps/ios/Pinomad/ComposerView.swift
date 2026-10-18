import AgentChatCore
import AgentChatKit
import PhotosUI
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
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var mentions = MentionCoordinator()
    @FocusState private var focused: Bool

    private var tray: AttachmentTray { model.trays[conversation.id] ?? AttachmentTray() }

    private var currentModel: ModelSummary? {
        summaryOf(models: model.snapshot?.models ?? [], model: conversation.agent.model)
    }

    /// Only a model that says it takes images gets them (Expo's rule).
    private var acceptsImages: Bool { currentModel?.images == true }

    /// Images staged, then a switch to a model that can't see them: keep
    /// them, say why, and hold the send until they're removed or the model
    /// changes back.
    private var imagesBlocked: Bool { !acceptsImages && !tray.images.isEmpty }

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

    private var roles: [AgentRole] { model.snapshot?.agents?.roles ?? [] }

    /// A shown conversation lists its own cwd; older hosts have no call.
    private var mentionScope: FileScope? {
        guard model.hostSupports("listFiles") else { return nil }
        return .conversation(conversationId: conversation.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !conversation.questions.isEmpty {
                QuestionCards(model: model, conversationId: conversation.id,
                              questions: conversation.questions, connected: connected)
            }
            if !conversation.statusText.isEmpty {
                StatusPill(text: conversation.statusText)
            }
            if !conversation.queueItems.isEmpty {
                QueueList(items: conversation.queueItems)
            }
            if mentions.menu.isShowing {
                MentionMenuView(menu: mentions.menu, choose: chooseMention)
            }
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onChange(of: draft.wrappedValue) { _, _ in refreshMentions() }
        .onChange(of: mentions.selection) { _, _ in refreshMentions() }
        .onChange(of: roles) { _, _ in refreshMentions() }
        .onChange(of: model.hostSupports("listFiles")) { _, _ in refreshMentions() }
        .onChange(of: model.phase) { _, _ in mentions.close() }
        .onDisappear { mentions.close() }
        .sheet(isPresented: $showModels) {
            ModelSheet(
                model: model,
                models: model.snapshot?.models ?? [],
                selected: ModelPick(
                    model: (model.snapshot?.conversation?.agent ?? conversation.agent).model,
                    level: (model.snapshot?.conversation?.agent ?? conversation.agent).thinkingLevel ?? .off),
                onModel: { model.setModel($0) },
                onLevel: { model.setThinkingLevel($0) }
            )
        }
        .imageSources(model: model, key: conversation.id, accepts: acceptsImages,
                      showPhotos: $showPhotos, showCamera: $showCamera)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !tray.isEmpty || tray.error != nil || imagesBlocked {
                AttachmentStrip(
                    tray: tray,
                    note: imagesBlocked ? "\(currentModel?.name ?? "当前模型")不支持图片，移除图片或换模型后再发送" : tray.error,
                    remove: { model.removeImage(conversation: conversation.id, at: $0) },
                    view: { model.viewing = $0 }
                )
            }
            TextField(
                conversation.busy ? "追加指令…" : "问点什么…",
                text: draft, selection: $mentions.selection, axis: .vertical
            )
            .lineLimit(1...6)
            .focused($focused)
            .disabled(!connected)
            .onChange(of: focused) { _, isFocused in
                guard isFocused else {
                    mentions.close()
                    return
                }
                refreshMentions()
                // Let the keyboard's inset land first, then show the end.
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    model.transcriptPin += 1
                }
            }
            HStack(spacing: 10) {
                PlusMenu(
                    connected: connected,
                    acceptsImages: acceptsImages,
                    modelName: currentModel?.name ?? currentModel?.modelId,
                    canAddImages: tray.freeSlots > 0,
                    photos: { presentAfterMenu { showPhotos = true } },
                    camera: UIImagePickerController.isSourceTypeAvailable(.camera)
                        ? { presentAfterMenu { showCamera = true } } : nil,
                    paste: { model.pasteImage(into: conversation.id, accepts: acceptsImages) },
                    compact: { model.compact() }
                )
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

    private func refreshMentions() {
        guard focused else {
            mentions.close()
            return
        }
        mentions.refresh(text: draft.wrappedValue, roles: roles, scope: mentionScope) { scope, query in
            try await model.listFiles(scope: scope, query: query)
        }
    }

    private func chooseMention(_ choice: MentionChoice) {
        guard let insertion = mentions.insert(choice, into: draft.wrappedValue) else { return }
        draft.wrappedValue = insertion.text
        mentions.selection = TextSelection(
            insertionPoint: String.Index(utf16Offset: insertion.cursor, in: insertion.text))
        focused = true
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
        // A blocked image set holds the send the same way preparing does.
        switch SendSlot(draft: draft.wrappedValue, connected: connected, busy: conversation.busy,
                        hasImages: !tray.images.isEmpty, preparing: tray.preparing > 0 || imagesBlocked) {
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
struct SlotIcon: View {
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

struct PlusMenu: View {
    let connected: Bool
    let acceptsImages: Bool
    let modelName: String?
    let canAddImages: Bool
    let photos: () -> Void
    /// Nil where there is no camera (the simulator).
    let camera: (() -> Void)?
    let paste: () -> Void
    /// Nil where there is no conversation yet (the draft page).
    let compact: (() -> Void)?

    var body: some View {
        Menu {
            if acceptsImages {
                Section {
                    Button("照片图库", systemImage: "photo.on.rectangle", action: photos)
                    if let camera {
                        Button("拍照", systemImage: "camera", action: camera)
                    }
                    Button("粘贴图片", systemImage: "doc.on.clipboard", action: paste)
                }
                .disabled(!canAddImages)
            } else {
                Button("添加图片（\(modelName ?? "当前模型")不支持图片）", systemImage: "photo") {}
                    .disabled(true)
            }
            if let compact {
                Button("压缩上下文", systemImage: "rectangle.compress.vertical", action: compact)
                    .disabled(!connected)
            }
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

/// Staged images (tap to view, × to drop), a spinner per image still being
/// prepared, and the last attach problem.
struct AttachmentStrip: View {
    let tray: AttachmentTray
    let note: String?
    let remove: (Int) -> Void
    let view: (MessageImage) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !tray.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(tray.images.enumerated()), id: \.offset) { index, image in
                            Thumbnail(image: image)
                                .onTapGesture { view(image) }
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        remove(index)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                            .font(.system(size: 18))
                                    }
                                    .buttonStyle(.plain)
                                    .offset(x: 5, y: -5)
                                    .accessibilityLabel("移除第 \(index + 1) 张图片")
                                }
                        }
                        ForEach(0..<tray.preparing, id: \.self) { _ in
                            ProgressView()
                                .frame(width: 56, height: 56)
                                .background(.fill.tertiary, in: .rect(cornerRadius: 10))
                        }
                    }
                    .padding(.top, 6)
                    .padding(.trailing, 6)
                }
                .scrollIndicators(.hidden)
            }
            if let note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }
}

/// A square crop of a staged image.
struct Thumbnail: View {
    let image: MessageImage

    var body: some View {
        Group {
            if let decoded = InlineImage.decoded(ToolImage(data: image.data, mimeType: image.mimeType)) {
                decoded.resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(.rect(cornerRadius: 10))
    }
}

struct ModelCapsule: View {
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
