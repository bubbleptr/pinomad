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
    /// The named agent the conversation runs as now, plus whether it can
    /// still change (ADR-0023, protocol 5.18). Not `conversation.agent`,
    /// which is the model/thinking config.
    let agentPick: ConversationAgent?

    @State private var showModels = false
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var mentions = MentionCoordinator()
    @State private var selection = NSRange()
    @State private var focused = false
    /// Bumped by each send, for the tap's haptic.
    @State private var sends = 0

    private var tray: AttachmentTray { model.trays[conversation.id] ?? AttachmentTray() }
    private var fileTray: FileAttachmentTray { model.fileTray(for: conversation.id) }
    private var filesPreparing: Bool { model.filePreparing(conversation.id) }
    private var filesBeingRead: Int { model.fileReads[conversation.id]?.count ?? 0 }

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

    /// The model sheet's Agent section: pickable on a 5.18+ host, read-only
    /// on an older one or a subagent, hidden when there is no agent to name.
    private var agentSheet: ModelSheetAgent? {
        guard let agentPick else { return nil }
        if agentPick.canSwitch {
            return .pick(rows: agentPick.rows, hint: nil, onSelect: { model.setAgent($0) })
        }
        guard let name = agentPick.current else { return nil }
        return .fixed(name: name, description: roles.first { $0.name == name }?.description)
    }

    /// The sheet also holds the Agent section: an empty model list alone
    /// must not keep it shut, or a named agent could not be cleared.
    private var sheetHasContent: Bool {
        guard let agentPick else { return !(model.snapshot?.models.isEmpty ?? true) }
        return agentPick.sheetHasContent(models: model.snapshot?.models ?? [])
    }

    /// A shown conversation lists its own cwd; older hosts have no call,
    /// and a Chat's cwd is never a project, so the host lists nothing.
    private var mentionScope: FileScope? {
        guard model.hostSupports("listFiles"), conversation.home != .chat else { return nil }
        return .conversation(conversationId: conversation.id)
    }

    /// A shown conversation — Chat included — lists the skills under its
    /// persisted cwd. Nil offline or before 5.13.
    private var skillScope: SkillScope? {
        model.conversationSkillScope(conversation.id)
    }

    private var skillEntries: [SkillEntry]? { model.skills(for: skillScope) }

    /// The host's `/` commands for this conversation; nil before 5.17,
    /// offline, or until the first answer.
    private var commandEntries: [CommandEntry]? { model.commands(for: conversation.id) }

    /// What tapping send does with the current draft.
    private var submit: ComposerSubmit {
        ComposerSubmit(draft: draft.wrappedValue, commands: commandEntries,
                       hasImages: !tray.images.isEmpty,
                       hasFiles: !fileTray.isEmpty || filesPreparing)
    }

    private var commandBlocked: String? {
        if case .blocked(let reason) = submit { return reason }
        return nil
    }

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
            if mentions.commandMenu.isShowing {
                CommandMenuView(menu: mentions.commandMenu, choose: chooseCommand)
            } else if mentions.skillMenu.isShowing {
                SkillMenuView(menu: mentions.skillMenu, choose: chooseSkill)
            } else if mentions.menu.isShowing {
                MentionMenuView(menu: mentions.menu, choose: chooseMention)
            }
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .onAppear {
            #if DEBUG
            if model.devShowsModelSheet {
                model.devShowsModelSheet = false
                showModels = true
            }
            #endif
            // Until the reader places the caret, an add entry goes at the end.
            selection = NSRange(location: (draft.wrappedValue as NSString).length, length: 0)
            // Known before the first `/`, so a typed command is recognised.
            model.requestCommands(for: conversation.id)
        }
        .onChange(of: draft.wrappedValue) { _, _ in
            model.syncChips(conversation.id)
            refreshMentions()
        }
        .onChange(of: selection) { _, _ in refreshMentions() }
        .onChange(of: roles) { _, _ in refreshMentions() }
        .onChange(of: model.hostSupports("listFiles")) { _, _ in refreshMentions() }
        .onChange(of: skillEntries) { _, _ in refreshMentions() }
        .onChange(of: commandEntries) { _, _ in refreshMentions() }
        .onChange(of: model.connected) { _, connected in
            if connected {
                model.requestSkills(for: skillScope, force: true)
                model.requestCommands(for: conversation.id, force: true)
            }
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
                agent: agentSheet,
                onModel: { model.setModel($0) },
                onLevel: { model.setThinkingLevel($0) }
            )
        }
        .imageSources(model: model, key: conversation.id, accepts: acceptsImages,
                      showPhotos: $showPhotos, showCamera: $showCamera)
        .fileAttachmentImporter(model: model, key: conversation.id, isPresented: $showFiles)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            if filesPreparing {
                Text("Uploading files…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if let status = fileTray.statusText {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !tray.isEmpty || !fileTray.isEmpty || filesPreparing || tray.error != nil
                || fileTray.error != nil || imagesBlocked || commandBlocked != nil {
                AttachmentStrip(
                    tray: tray,
                    files: fileTray,
                    preparingFiles: filesBeingRead,
                    note: imagesBlocked
                        ? "\(currentModel?.name ?? "This model") doesn't accept images. Remove them or switch models to send."
                        : commandBlocked ?? fileTray.error ?? tray.error,
                    removeImage: { model.removeImage(conversation: conversation.id, at: $0) },
                    removeFile: { model.removeFile(conversation: conversation.id, id: $0) },
                    retryFile: { model.retryFile(conversation: conversation.id, id: $0) },
                    view: { model.viewing = $0 }
                )
            }
            SkillComposerText(
                text: draft,
                selection: $selection,
                focused: $focused,
                placeholder: conversation.busy ? "Add a follow-up…" : ComposerPlaceholder.text(
                    lead: "Ask", agents: !roles.isEmpty, files: mentionScope != nil,
                    commands: model.hostSupports("listCommands"), skills: skillScope != nil),
                chips: model.chips(for: conversation.id).ranges,
                expandDeletion: { model.chips(for: conversation.id).deletion(expanding: $0) },
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
                plusMenu
                ModelCapsule(
                    label: modelText,
                    logo: conversation.agent.model,
                    prefix: agentPick?.current.map { "@\($0)" },
                    enabled: connected && sheetHasContent
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

    private var plusMenu: some View {
        let commands = model.hostSupports("listCommands")
        let useSkill: (() -> Void)? = skillScope == nil ? nil : { insertTrigger("$") }
        let mentionAgent: (() -> Void)? = roles.isEmpty ? nil : { insertTrigger("@") }
        let camera: (() -> Void)? = UIImagePickerController.isSourceTypeAvailable(.camera)
            ? { presentAfterMenu { showCamera = true } } : nil
        // Before 5.17 there is no `/` menu, only Compact.
        let compact: (() -> Void)? = commands ? nil : { model.compact() }
        // A command starts the message, so `/` replaces a blank draft.
        let runCommand: (() -> Void)? = !commands ? nil : {
            insertTrigger("/", selection: NSRange(location: 0, length: draft.wrappedValue.utf16.count))
        }
        let runCommandBlocked: String? = switch commandEntries {
        case nil: "Loading…"
        case let entries? where entries.isEmpty: "None on this host"
        case _ where !draft.wrappedValue.allSatisfy(\.isWhitespace) || !tray.isEmpty
            || !fileTray.isEmpty || filesPreparing:
            "Clear the message first"
        default: nil
        }
        return PlusMenu(
            connected: connected,
            acceptsImages: acceptsImages,
            modelName: currentModel?.name ?? currentModel?.modelId,
            canAddImages: tray.freeSlots > 0,
            locked: editLocked,
            attachFiles: model.hostSupports(.attachments)
                ? { presentAfterMenu { showFiles = true } } : nil,
            photos: { presentAfterMenu { showPhotos = true } },
            camera: camera,
            paste: { model.pasteImage(into: conversation.id, accepts: acceptsImages) },
            useSkill: useSkill,
            mentionAgent: mentionAgent,
            runCommand: runCommand,
            runCommandBlocked: runCommandBlocked,
            compact: compact,
            onOpen: { model.requestCommands(for: conversation.id) }
        )
    }

    private func refreshMentions() {
        guard focused, selection.length == 0 else {
            mentions.close()
            return
        }
        // Cheap when fresh; a stale entry refetches as the menu opens.
        model.requestSkills(for: skillScope)
        model.requestCommands(for: conversation.id)
        mentions.refresh(
            text: draft.wrappedValue,
            caret: selection.location,
            roles: roles,
            fileScope: mentionScope,
            skills: skillEntries,
            commands: commandEntries
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

    /// A pick is a chip: `$name ` goes in as text and its `$name` binds.
    private func chooseSkill(_ skill: SkillEntry) {
        guard let insertion = mentions.insert(skill, into: draft.wrappedValue) else { return }
        apply(insertion)
        model.bindSkillChip(skill.name, at: insertion.cursor - ("$" + skill.name + " ").utf16.count,
                            in: conversation.id)
    }

    private func chooseCommand(_ command: CommandEntry) {
        guard let insertion = mentions.insert(command, into: draft.wrappedValue) else { return }
        apply(insertion)
    }

    /// An add entry's trigger over `selection` (the caret by default);
    /// focusing opens its menu.
    private func insertTrigger(_ trigger: String, selection: NSRange? = nil) {
        apply(ComposerTrigger.insert(trigger, into: draft.wrappedValue, selection: selection ?? self.selection))
    }

    private func apply(_ insertion: MentionInsertion) {
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

    /// A recognised command runs at once whatever `mode` says; a held one
    /// (images, disabled) never leaves.
    private func send(_ mode: SubmitMode) {
        switch submit {
        case .command(let name, let args):
            model.runDraftCommand(conversation: conversation.id, name: name, args: args)
        case .message:
            model.send(conversation: conversation.id, mode: mode)
        case .blocked:
            return
        }
        sends += 1
    }

    @ViewBuilder
    private var sendSlot: some View {
        // A blocked image set holds the send the same way preparing does.
        switch SendSlot(draft: draft.wrappedValue, connected: connected, busy: conversation.busy,
                        hasImages: !tray.images.isEmpty,
                        preparing: tray.preparing > 0 || imagesBlocked || commandBlocked != nil,
                        hasFiles: !fileTray.isEmpty || filesPreparing,
                        filesBlocked: !fileTray.canSend || filesPreparing,
                        command: submit != .message) {
        case .stop(let enabled):
            Button {
                model.stop(conversation: conversation.id)
            } label: {
                SlotIcon(.stop)
            }
            .buttonStyle(.press)
            .accessibilityLabel("Stop")
            .disabled(!enabled)
        case .send(let enabled, let canSteer):
            if canSteer {
                // Tap queues a follow-up; the long-press menu can steer
                // the running turn instead.
                Menu {
                    Button("Steer the current run", image: .redo2) {
                        send(.steer)
                    }
                    Button("Send after this run (follow-up)", image: .listEnd) {
                        send(.followUp)
                    }
                } label: {
                    SlotIcon(.send)
                } primaryAction: {
                    send(.followUp)
                }
                .menuStyle(.button)
                .buttonStyle(PressStyle(haptic: false))
                .accessibilityLabel("Send")
                .accessibilityHint("Sends after the run finishes. Long-press to steer now instead.")
                .disabled(!enabled || editLocked)
            } else {
                Button {
                    send(.followUp)
                } label: {
                    SlotIcon(.send)
                }
                .buttonStyle(PressStyle(haptic: false))
                .accessibilityLabel("Send")
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

/// The composer's single entry for everything that can be added to a draft
/// (issue #254), one flat list: images, then the bare `$`, `@` and `/`
/// triggers that open the matching menu (files are reached by typing `@`).
/// Entries the host or scope can't support are hidden, ones unavailable for
/// now are greyed with the reason in the label.
struct PlusMenu: View {
    let connected: Bool
    let acceptsImages: Bool
    let modelName: String?
    let canAddImages: Bool
    /// An Edit is resolving: every add entry waits for it so a late refill
    /// cannot mix with a new pick.
    let locked: Bool
    /// Nil before 5.19: the entry is hidden, not greyed.
    let attachFiles: (() -> Void)?
    let photos: () -> Void
    /// Nil where there is no camera (the simulator).
    let camera: (() -> Void)?
    let paste: () -> Void
    /// Each nil when the host or scope can't offer it.
    let useSkill: (() -> Void)?
    let mentionAgent: (() -> Void)?
    /// Opens the `/` menu: nil off a conversation or before 5.17.
    let runCommand: (() -> Void)?
    /// Why Run a Command is greyed right now.
    let runCommandBlocked: String?
    /// Only for a host before 5.17; newer hosts list `/compact` in the `/` menu.
    let compact: (() -> Void)?
    /// The menu is about to open — the moment to refresh what it lists.
    let onOpen: (() -> Void)?

    init(
        connected: Bool,
        acceptsImages: Bool,
        modelName: String?,
        canAddImages: Bool,
        locked: Bool = false,
        attachFiles: (() -> Void)? = nil,
        photos: @escaping () -> Void,
        camera: (() -> Void)?,
        paste: @escaping () -> Void,
        useSkill: (() -> Void)?,
        mentionAgent: (() -> Void)?,
        runCommand: (() -> Void)? = nil,
        runCommandBlocked: String? = nil,
        compact: (() -> Void)? = nil,
        onOpen: (() -> Void)? = nil
    ) {
        self.connected = connected
        self.acceptsImages = acceptsImages
        self.modelName = modelName
        self.canAddImages = canAddImages
        self.locked = locked
        self.attachFiles = attachFiles
        self.photos = photos
        self.camera = camera
        self.paste = paste
        self.useSkill = useSkill
        self.mentionAgent = mentionAgent
        self.runCommand = runCommand
        self.runCommandBlocked = runCommandBlocked
        self.compact = compact
        self.onOpen = onOpen
    }

    var body: some View {
        Menu {
            if acceptsImages {
                Group {
                    Button("Photo Library", image: .images, action: photos)
                    if let camera {
                        Button("Take Photo", image: .camera, action: camera)
                    }
                    Button("Paste Image", image: .clipboardPaste, action: paste)
                }
                .disabled(!canAddImages || locked)
            } else {
                Button("Add Images (\(modelName ?? "this model") doesn't accept images)", image: .image) {}
                    .disabled(true)
            }
            if let attachFiles {
                Button("Attach files…", image: .file, action: attachFiles)
                    .disabled(!connected || locked)
            }
            // Text triggers need the field, which is off while offline or
            // locked by an Edit.
            Group {
                if let useSkill {
                    Button("Use a Skill", image: .sparkles, action: useSkill)
                }
                if let mentionAgent {
                    Button("Mention an Agent", image: .userRound, action: mentionAgent)
                }
                if let runCommand {
                    Button(action: runCommand) {
                        Text("Run a Command")
                        if let runCommandBlocked {
                            Text(runCommandBlocked)
                        }
                        Image(.squareSlash)
                    }
                    .disabled(runCommandBlocked != nil)
                }
            }
            .disabled(!connected || locked)
            if let compact {
                Button("Compact Conversation", image: .foldVertical, action: compact)
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
        .accessibilityLabel("Add")
        // Menu has no "will open" hook; a simultaneous tap on the label
        // fires as it opens without taking the tap from the menu.
        .simultaneousGesture(TapGesture().onEnded { onOpen?() })
    }
}

/// Staged images and files (tap an image to view, × to drop), a spinner per
/// image still being prepared, and the last attach problem.
struct AttachmentStrip: View {
    let tray: AttachmentTray
    let files: FileAttachmentTray
    /// Picks still being read; shown as spinner chips, like image prep.
    let preparingFiles: Int
    let note: String?
    let removeImage: (Int) -> Void
    let removeFile: (String) -> Void
    let retryFile: (String) -> Void
    let view: (MessageImage) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !tray.isEmpty || !files.isEmpty || preparingFiles > 0 {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(tray.images.enumerated()), id: \.offset) { index, image in
                            Thumbnail(image: image)
                                .onTapGesture { view(image) }
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        removeImage(index)
                                    } label: {
                                        Image(.x)
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundStyle(.white)
                                            .frame(width: 18, height: 18)
                                            .background(.black.opacity(0.6), in: .circle)
                                    }
                                    .buttonStyle(.press)
                                    .offset(x: 5, y: -5)
                                    .accessibilityLabel("Remove image \(index + 1)")
                                }
                        }
                        ForEach(files.entries) { entry in
                            FileAttachmentChip(
                                entry: entry,
                                retry: { retryFile(entry.id) },
                                remove: { removeFile(entry.id) }
                            )
                        }
                        ForEach(0..<(tray.preparing + preparingFiles), id: \.self) { _ in
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
    /// The picked model, for its logo ahead of everything else.
    let logo: ModelRef?
    /// The named agent (`@name`) the pick comes from, shown first.
    let prefix: String?
    let enabled: Bool
    /// Why the shown pick can't be sent — replaces the label in red.
    let problem: String?
    let action: () -> Void

    init(label: String, logo: ModelRef?, prefix: String? = nil, enabled: Bool,
         problem: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.logo = logo
        self.prefix = prefix
        self.enabled = enabled
        self.problem = problem
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let problem {
                    Text(problem)
                        .lineLimit(1)
                        .foregroundStyle(.red)
                } else {
                    if let logo {
                        ModelLogo(model: logo, size: 14)
                            .padding(.trailing, 2)
                    }
                    if let prefix {
                        Text(prefix)
                            .fontWeight(.medium)
                            .lineLimit(1)
                            // The model label truncates first.
                            .layoutPriority(1)
                    }
                    Text(label.isEmpty ? "Choose model" : label)
                        .lineLimit(1)
                }
                Image(.chevronDown)
                    .font(.caption2.weight(.semibold))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(.fill.tertiary, in: .capsule)
        }
        .buttonStyle(.press)
        .disabled(!enabled)
        .accessibilityLabel(problem.map { "Model: \($0)" }
            ?? "Model: \([prefix, label].compactMap { $0 }.joined(separator: " "))")
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
                Text("· \(item.imageCount) image\(item.imageCount == 1 ? "" : "s")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if item.attachmentCount > 0 {
                Text("· \(item.attachmentCount) file\(item.attachmentCount == 1 ? "" : "s")")
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
                .accessibilityLabel("Queued message actions")
                .accessibilityHint("Steer, edit, or withdraw this queued message")
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
            Button("Steer now", image: .redo2) {
                onSteer(item)
            }
            .disabled(blocked)
        }
        Button("Edit", image: .pencil) {
            onEdit(item)
        }
        .disabled(blocked || editDisabled)
        Button("Withdraw", image: .undo2, role: .destructive) {
            onWithdraw(item)
        }
        .disabled(blocked)
    }

    private func tag(_ mode: QueueMode) -> String {
        switch mode {
        case .steer: "Steer"
        case .followUp: "Follow-up"
        case .write, .other: "Queued"
        }
    }
}
