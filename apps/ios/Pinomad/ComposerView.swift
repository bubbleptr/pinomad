import AgentChatCore
import AgentChatKit
import PhotosUI
import PinomadChat
import PinomadCore
import SwiftUI

/// The shown conversation's input: run status and queued inputs above a
/// glass card holding the draft and its actions. Sits in the transcript's
/// bottom safe-area bar, so the keyboard and the scroll inset follow it.
struct ConversationComposer: View {
    let model: AppModel
    let conversation: ConversationSnapshot

    @State private var showModels = false
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var mentions = MentionCoordinator()
    @State private var selection = NSRange()
    @State private var focused = false
    /// Bumped by each send, for the tap's haptic.
    @State private var sends = 0

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

    /// A shown conversation — Chat included — lists the skills under its
    /// persisted cwd. Nil offline or before 5.13.
    private var skillScope: SkillScope? {
        model.conversationSkillScope(conversation.id)
    }

    private var skillEntries: [SkillEntry]? { model.skills(for: skillScope) }

    /// The 5.14 queued-input calls: live connection plus a host that knows
    /// them. Older hosts and offline rows keep their plain display.
    private var canActOnQueue: Bool {
        connected && model.hostSupports("withdrawQueued")
    }

    /// An Edit's withdraw is in flight, or its outcome is unknown after a
    /// drop: the composer and every attachment entry stay locked.
    private var editLocked: Bool {
        model.queuedEditLocksComposer(conversation: conversation.id)
    }

    private var editDisabled: Bool {
        model.queuedEditDisabled(conversation: conversation.id)
    }

    private var queuePending: Set<UInt64> {
        var pending = model.queuePending
        if let id = model.queuedEdit.copy?.id { pending.insert(id) }
        return pending
    }

    private var editFocusRevision: UInt64 {
        model.queuedEditFocus[conversation.id] ?? 0
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
                QueueList(
                    items: conversation.queueItems,
                    busy: conversation.busy,
                    canAct: canActOnQueue,
                    editDisabled: editDisabled,
                    pending: queuePending,
                    onSteer: { model.steerQueued(conversation: conversation.id, item: $0) },
                    onEdit: { model.editQueued(conversation: conversation.id, item: $0) },
                    onWithdraw: { model.withdrawQueued(conversation: conversation.id, item: $0) }
                )
            }
            if mentions.skillMenu.isShowing {
                SkillMenuView(menu: mentions.skillMenu, choose: chooseSkill)
            } else if mentions.menu.isShowing {
                MentionMenuView(menu: mentions.menu, choose: chooseMention)
            }
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .onChange(of: draft.wrappedValue) { _, _ in refreshMentions() }
        .onChange(of: selection) { _, _ in refreshMentions() }
        .onChange(of: roles) { _, _ in refreshMentions() }
        .onChange(of: model.hostSupports("listFiles")) { _, _ in refreshMentions() }
        .onChange(of: skillEntries) { _, _ in refreshMentions() }
        .onChange(of: model.connected) { _, connected in
            if connected { model.requestSkills(for: skillScope, force: true) }
            refreshMentions()
        }
        .onChange(of: model.phase) { _, _ in mentions.close() }
        .onChange(of: editFocusRevision) { _, _ in
            // The Edit refill lands asynchronously; put the caret after it
            // and focus once the now-enabled field is on screen.
            selection = NSRange(location: (draft.wrappedValue as NSString).length, length: 0)
            focused = true
        }
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
            SkillComposerText(
                text: draft,
                selection: $selection,
                focused: $focused,
                placeholder: conversation.busy ? "追加指令…" : "问点什么…",
                names: skillEntries?.map(\.name),
                enabled: connected && !editLocked,
                minLines: 1,
                maxLines: 6
            )
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
                    locked: editLocked,
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
                ContextMeterView(usage: conversation.contextUsage)
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
        guard focused, selection.length == 0 else {
            mentions.close()
            return
        }
        // Cheap when fresh; a stale entry refetches as the menu opens.
        model.requestSkills(for: skillScope)
        mentions.refresh(
            text: draft.wrappedValue,
            caret: selection.location,
            roles: roles,
            fileScope: mentionScope,
            skills: skillEntries
        ) { scope, query in
            try await model.listFiles(scope: scope, query: query)
        }
    }

    private func chooseMention(_ choice: MentionChoice) {
        guard let insertion = mentions.insert(choice, into: draft.wrappedValue) else { return }
        draft.wrappedValue = insertion.text
        selection = NSRange(location: insertion.cursor, length: 0)
        focused = true
    }

    private func chooseSkill(_ skill: SkillEntry) {
        guard let insertion = mentions.insert(skill, into: draft.wrappedValue) else { return }
        draft.wrappedValue = insertion.text
        selection = NSRange(location: insertion.cursor, length: 0)
        focused = true
    }

    private var modelText: String {
        let agent = conversation.agent
        return modelLabel(
            models: model.snapshot?.models ?? [],
            selected: ModelPick(model: agent.model, level: agent.thinkingLevel ?? .off)
        )
    }

    private func send(_ mode: SubmitMode) {
        model.send(conversation: conversation.id, mode: mode)
        sends += 1
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
                SlotIcon(.stop)
            }
            .buttonStyle(.press)
            .accessibilityLabel("停止")
            .disabled(!enabled)
        case .send(let enabled, let canSteer):
            if canSteer {
                // Tap queues a follow-up; the long-press menu can steer
                // the running turn instead.
                Menu {
                    Button("引导当前运行（Steer）", image: .redo2) {
                        send(.steer)
                    }
                    Button("运行完再发（Follow-up）", image: .listEnd) {
                        send(.followUp)
                    }
                } label: {
                    SlotIcon(.send)
                } primaryAction: {
                    send(.followUp)
                }
                .menuStyle(.button)
                .buttonStyle(PressStyle(haptic: false))
                .accessibilityLabel("发送")
                .accessibilityHint("运行结束后发送；长按可改为立即引导")
                .disabled(!enabled || editLocked)
            } else {
                Button {
                    send(.followUp)
                } label: {
                    SlotIcon(.send)
                }
                .buttonStyle(PressStyle(haptic: false))
                .accessibilityLabel("发送")
                .disabled(!enabled || editLocked)
            }
        }
    }
}

/// The filled circle the trailing slot shows for send and stop.
struct SlotIcon: View {
    enum Glyph { case send, stop }

    let glyph: Glyph
    @Environment(\.isEnabled) private var isEnabled

    init(_ glyph: Glyph) { self.glyph = glyph }

    var body: some View {
        Group {
            switch glyph {
            case .send: Image(.arrowUp).font(.system(size: 15, weight: .bold))
            // A solid square: Lucide has no filled stop.
            case .stop: RoundedRectangle(cornerRadius: 3).frame(width: 12, height: 12)
            }
        }
            // Concrete colors: on glass the hierarchical `.primary` gets
            // vibrancy and reads as a disabled grey.
            .foregroundStyle(Color(uiColor: .systemBackground))
            .frame(width: 34, height: 34)
            .background {
                // A small domed key: light from above, a lip on the top
                // edge, a contact shadow under it.
                Circle()
                    .fill(Color(uiColor: isEnabled ? .label : .tertiaryLabel))
                    // Lit top and shaded bottom: the white key in dark mode
                    // hides a white lip, so the shade carries the dome there.
                    .overlay {
                        Circle().fill(LinearGradient(stops: [
                            .init(color: .white.opacity(0.22), location: 0),
                            .init(color: .clear, location: 0.5),
                            .init(color: .black.opacity(0.14), location: 1),
                        ], startPoint: .top, endPoint: .bottom))
                    }
                    .overlay { TopLip(shape: Circle(), color: .white.opacity(0.35)) }
                    .shadow(color: .black.opacity(isEnabled ? 0.18 : 0), radius: 2, y: 1.5)
            }
    }
}

struct PlusMenu: View {
    let connected: Bool
    let acceptsImages: Bool
    let modelName: String?
    let canAddImages: Bool
    /// An Edit is resolving: every attachment entry waits for it so a late
    /// refill cannot mix with a new pick.
    var locked = false
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
                    Button("照片图库", image: .images, action: photos)
                    if let camera {
                        Button("拍照", image: .camera, action: camera)
                    }
                    Button("粘贴图片", image: .clipboardPaste, action: paste)
                }
                .disabled(!canAddImages || locked)
            } else {
                Button("添加图片（\(modelName ?? "当前模型")不支持图片）", image: .image) {}
                    .disabled(true)
            }
            if let compact {
                Button("压缩上下文", image: .foldVertical, action: compact)
                    .disabled(!connected)
            }
        } label: {
            Image(.plus)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 34, height: 34)
                .background(.fill.tertiary, in: .circle)
        }
        .menuStyle(.button)
        .buttonStyle(.press)
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
                                        Image(.x)
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundStyle(.white)
                                            .frame(width: 18, height: 18)
                                            .background(.black.opacity(0.6), in: .circle)
                                    }
                                    .buttonStyle(.press)
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
    /// A muted suffix, e.g. which side of a named-agent pick is inherited.
    let sourceHint: String?
    /// Why the shown pick can't be sent — replaces the label in red.
    let problem: String?
    let action: () -> Void

    init(label: String, enabled: Bool, sourceHint: String? = nil,
         problem: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.enabled = enabled
        self.sourceHint = sourceHint
        self.problem = problem
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            // A source hint shares the line, so tighten the spacing only
            // then — the conversation page's capsule is unchanged.
            HStack(spacing: sourceHint == nil ? 4 : 2) {
                if let problem {
                    Text(problem)
                        .lineLimit(1)
                        .foregroundStyle(.red)
                } else {
                    Text(label.isEmpty ? "选择模型" : label)
                        .lineLimit(1)
                        // The label keeps its width; the hint truncates first
                        // when the capsule runs out of room.
                        .layoutPriority(1)
                    if let sourceHint {
                        Text(sourceHint)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Image(.chevronDown)
                    .font(.caption2.weight(.semibold))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, sourceHint == nil ? 12 : 8)
            .frame(height: 34)
            .background(.fill.tertiary, in: .capsule)
        }
        .buttonStyle(.press)
        .disabled(!enabled)
        .accessibilityLabel(problem.map { "模型：\($0)" } ?? "模型：\(label)")
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
/// Only steer/follow-up rows carry actions — the protocol rejects writes —
/// and only while the host is live on 5.14.
private struct QueueList: View {
    let items: [QueueItem]
    /// A run is in flight; Steer only makes sense while one is.
    let busy: Bool
    /// The connection is live and the host knows the 5.14 calls.
    let canAct: Bool
    /// Edit is unavailable for every row — the composer already holds a
    /// draft or attachment, or another Edit is unresolved.
    let editDisabled: Bool
    /// Rows with a request in flight; their actions stay disabled.
    let pending: Set<UInt64>
    let onSteer: (QueueItem) -> Void
    let onEdit: (QueueItem) -> Void
    let onWithdraw: (QueueItem) -> Void

    /// The action target is 44pt, so a row is 48pt. The ScrollView takes all
    /// the height it is offered, so its frame tracks this estimate up to
    /// three rows.
    private static let rowHeight: CGFloat = 48
    private static let spacing: CGFloat = 6
    private static let visibleRows = 3

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Self.spacing) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    row(item)
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollClipDisabled()
        .frame(height: height)
    }

    private var height: CGFloat {
        let count = CGFloat(items.count)
        guard count > 0 else { return 0 }
        let content = count * Self.rowHeight + (count - 1) * Self.spacing
        let visible = CGFloat(Self.visibleRows) * Self.rowHeight
            + CGFloat(Self.visibleRows - 1) * Self.spacing
        return min(content, visible)
    }

    private func actionable(_ item: QueueItem) -> Bool {
        canAct && (item.mode == .followUp || item.mode == .steer)
    }

    @ViewBuilder
    private func row(_ item: QueueItem) -> some View {
        if actionable(item) {
            base(item).contextMenu { actions(item) }
        } else {
            base(item)
        }
    }

    private func base(_ item: QueueItem) -> some View {
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
            if actionable(item) {
                Menu {
                    actions(item)
                } label: {
                    Image(.ellipsis)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .menuStyle(.button)
                .buttonStyle(.press)
                .disabled(pending.contains(item.id))
                .accessibilityLabel("排队消息操作")
                .accessibilityHint("引导、编辑或撤回这条排队消息")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, actionable(item) ? 2 : 12)
        .frame(minHeight: Self.rowHeight)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }

    @ViewBuilder
    private func actions(_ item: QueueItem) -> some View {
        let blocked = pending.contains(item.id)
        // Write/other never reach here: the host rejects both calls for them.
        if item.mode == .followUp && busy {
            Button("引导当前运行", image: .redo2) {
                onSteer(item)
            }
            .disabled(blocked)
        }
        Button("编辑", image: .pencil) {
            onEdit(item)
        }
        .disabled(blocked || editDisabled)
        Button("撤回", image: .undo2, role: .destructive) {
            onWithdraw(item)
        }
        .disabled(blocked)
    }

    private func tag(_ mode: QueueMode) -> String {
        switch mode {
        case .steer: "引导"
        case .followUp: "追加"
        case .write, .other: "排队"
        }
    }
}
