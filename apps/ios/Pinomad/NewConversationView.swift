import PinomadChat
import PinomadCore
import SwiftUI

/// The new-conversation draft: a composer whose send creates the
/// conversation (at the chosen home, checkout and model) and then shows it
/// in this page's place. Its text and images live in the model under
/// `AppModel.draftKey`, so leaving and coming back keeps them.
struct NewConversationView: View {
    let model: AppModel

    @State private var showModels = false
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var mentions = MentionCoordinator()
    @State private var selection = NSRange()
    @State private var focused = false
    @Namespace private var chips

    private let key = AppModel.draftKey
    private var tray: AttachmentTray { model.trays[key] ?? AttachmentTray() }
    private var fileTray: FileAttachmentTray { model.fileTray(for: key) }
    private var filesPreparing: Bool { model.filePreparing(key) }
    private var filesBeingRead: Int { model.fileReads[key]?.count ?? 0 }
    private var pick: ModelPick { model.effectiveDraftPick }
    private var resolution: AgentDraft? { model.draftResolution }
    private var currentModel: ModelSummary? { summaryOf(models: model.snapshot?.models ?? [], model: pick.model) }
    private var acceptsImages: Bool { currentModel?.images == true }
    private var imagesBlocked: Bool { !acceptsImages && !tray.images.isEmpty }
    private var projects: [Project] { model.snapshot?.organized.projects.map(\.project) ?? [] }

    private var draft: Binding<String> {
        Binding(get: { model.drafts[key] ?? "" }, set: { model.drafts[key] = $0 })
    }

    private var roles: [AgentRole] { model.snapshot?.agents?.roles ?? [] }
    private var selectedAgent: String? { model.draftAgent.agent }

    /// Whether this host knows `createConversation`'s agent arg.
    private var agentPickerAvailable: Bool { model.hostSupports(.agentConversations) }

    /// The model sheet's Agent section stays while a pick survives a
    /// now-empty snapshot so the reader can clear it (the web's rule); an
    /// empty roles list alone hides it. A pick that outlived a host
    /// downgrade keeps the section with only "No Agent" — otherwise there is
    /// no way back to a plain draft.
    private var showAgentPicker: Bool {
        model.draftAgent.offersAgents(hostSupportsAgents: agentPickerAvailable, roles: roles)
    }

    private var agentChoice: ModelSheetAgent? {
        guard showAgentPicker else { return nil }
        return .pick(
            rows: AgentPickRow.rows(selected: selectedAgent,
                                    roles: agentPickerAvailable ? roles : []),
            hint: sourceHint,
            onSelect: { model.setDraftAgent($0) })
    }

    /// Which sides still come from the picked role; an overridden side is
    /// the reader's own.
    private var sourceHint: String? {
        guard let agent = selectedAgent, let resolution else { return nil }
        let modelInherited = resolution.modelFrom != .override
        let levelInherited = resolution.levelFrom != .override
        if modelInherited && levelInherited { return "Model and thinking level come from @\(agent)." }
        if modelInherited { return "Model comes from @\(agent); the thinking level is your pick." }
        if levelInherited { return "Thinking level comes from @\(agent); the model is your pick." }
        return "Model and thinking level are your picks; the rest comes from @\(agent)."
    }

    /// The capsule's short red label and the card's full reason when the
    /// named-agent create would be refused.
    private var problemText: (label: String, reason: String)? {
        guard let problem = resolution?.problem else { return nil }
        switch problem {
        case let .agentMissing(agent, reason):
            let base = "No agent role @\(agent) on this host"
            return ("@\(agent) unavailable", reason.map { base + ": \($0)" } ?? base)
        case let .modelMissing(agent):
            return ("No model for @\(agent)", "@\(agent) doesn't set a model and the host has no default model")
        case let .modelUnavailable(agent, model, source):
            let name = "\(model.provider)/\(model.modelId)"
            let from: String
            switch source {
            case .agent: from = "@\(agent)'s model"
            case .`default`: from = "the host's default model"
            case .override: from = "the selected model"
            }
            return ("\(name) unavailable", "\(name) (\(from)) isn't in the host's model list")
        }
    }

    /// The draft's chosen checkout decides whether a fresh worktree's HEAD
    /// files or the project directory's live files are candidates. A Chat
    /// draft has no project scope at all.
    private var mentionScope: FileScope? {
        guard model.hostSupports("listFiles"), case .project(let path) = model.draftHome else {
            return nil
        }
        return .project(path: path, checkout: model.draftCheckout)
    }

    /// The draft's skill scope follows its home and checkout: a project
    /// checkout, or the Chat draft's user-only listing.
    private var skillScope: SkillScope? { model.draftSkillScope() }

    private var skillEntries: [SkillEntry]? { model.skills(for: skillScope) }

    private var canSend: Bool {
        model.connected && !model.creating && tray.preparing == 0 && !imagesBlocked
            && fileTray.canSend && !filesPreparing
            && resolution?.problem == nil
            && (!draft.wrappedValue.allSatisfy(\.isWhitespace) || !tray.images.isEmpty || !fileTray.isEmpty)
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("What should Pi do?")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Spacer()
            if mentions.skillMenu.isShowing {
                SkillMenuView(menu: mentions.skillMenu, choose: chooseSkill)
            } else if mentions.menu.isShowing {
                MentionMenuView(menu: mentions.menu, choose: chooseMention)
            }
            VStack(alignment: .leading, spacing: 8) {
                location
                card
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .navigationTitle("New Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // A kept draft resumes at its end, where add entries go too.
            selection = NSRange(location: (draft.wrappedValue as NSString).length, length: 0)
            focused = true
        }
        .onChange(of: draft.wrappedValue) { _, _ in
            model.syncChips(key)
            refreshMentions()
        }
        .onChange(of: selection) { _, _ in refreshMentions() }
        .onChange(of: roles) { _, _ in refreshMentions() }
        .onChange(of: model.draftHome) { _, _ in refreshMentions() }
        .onChange(of: model.draftCheckout) { _, _ in refreshMentions() }
        .onChange(of: model.hostSupports("listFiles")) { _, _ in refreshMentions() }
        .onChange(of: skillEntries) { _, _ in refreshMentions() }
        .onChange(of: model.connected) { _, connected in
            if connected { model.requestSkills(for: skillScope, force: true) }
            refreshMentions()
        }
        .onChange(of: model.phase) { _, _ in mentions.close() }
        .onChange(of: focused) { _, isFocused in
            if isFocused { refreshMentions() } else { mentions.close() }
        }
        .onDisappear { mentions.close() }
        .sheet(isPresented: $showModels) {
            ModelSheet(
                model: model,
                models: model.snapshot?.models ?? [],
                selected: pick,
                agent: agentChoice,
                locked: model.creating,
                onModel: { model.setDraftModel($0) },
                onLevel: { model.setDraftLevel($0) }
            )
        }
        .imageSources(model: model, key: key, accepts: acceptsImages,
                      showPhotos: $showPhotos, showCamera: $showCamera)
        .fileAttachmentImporter(model: model, key: key, isPresented: $showFiles)
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
                || fileTray.error != nil || imagesBlocked {
                AttachmentStrip(
                    tray: tray,
                    files: fileTray,
                    preparingFiles: filesBeingRead,
                    note: imagesBlocked ? "\(currentModel?.name ?? "This model") doesn't accept images. Remove them or switch models to send." : fileTray.error ?? tray.error,
                    // The create already took these; a change now would be
                    // lost when the draft clears.
                    removeImage: { if !model.creating { model.removeImage(conversation: key, at: $0) } },
                    removeFile: { if !model.creating { model.removeFile(conversation: key, id: $0) } },
                    retryFile: { if !model.creating { model.retryFile(conversation: key, id: $0) } },
                    view: { model.viewing = $0 }
                )
            }
            SkillComposerText(
                text: draft,
                selection: $selection,
                focused: $focused,
                // A draft has no `/` commands until it is a conversation.
                placeholder: ComposerPlaceholder.text(
                    lead: "Do anything with Pi", agents: !roles.isEmpty, files: mentionScope != nil,
                    commands: false, skills: skillScope != nil),
                chips: model.chips(for: key).ranges,
                expandDeletion: { model.chips(for: key).deletion(expanding: $0) },
                enabled: model.connected && !model.creating,
                minLines: 3,
                maxLines: 8
            )
            if let problemText {
                Text(problemText.reason)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                plusMenu
                // Images added mid-create would miss the request and then be
                // cleared with the draft — hold the menu like the text field.
                .disabled(model.creating)
                ModelCapsule(
                    label: modelLabel(models: model.snapshot?.models ?? [], selected: pick),
                    logo: pick.model,
                    short: ModelCapsule.short(models: model.snapshot?.models ?? [], pick: pick),
                    prefix: selectedAgent.map { "@\($0)" },
                    // The sheet is the only way to the agent, so roles or a
                    // stale pick open it even without models. Locked while
                    // creating: the create already took the pick.
                    enabled: model.connected && !model.creating
                        && model.draftAgent.sheetHasContent(
                            models: model.snapshot?.models ?? [],
                            hostSupportsAgents: agentPickerAvailable, roles: roles),
                    problem: problemText?.label
                ) {
                    focused = false
                    showModels = true
                }
                // Let the capsule take its ideal width; the spacer gives up
                // the room first so the agent and model both read.
                .layoutPriority(1)
                Spacer(minLength: 0)
                if model.creating {
                    ProgressView().frame(width: 34, height: 34)
                } else {
                    Button {
                        Task { await model.createConversation() }
                    } label: {
                        SlotIcon(.send)
                    }
                    .buttonStyle(PressStyle(haptic: false))
                    .disabled(!canSend)
                    .accessibilityLabel("Start conversation")
                }
            }
            .frame(minHeight: 34)
            .sensoryFeedback(.impact(weight: .light), trigger: model.creating) { old, new in !old && new }
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
        // A draft's scope changes with its home/checkout, so ask for the
        // new scope here; the cache keeps old scopes isolated.
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

    /// A pick is a chip: `$name ` goes in as text and its `$name` binds.
    private func chooseSkill(_ skill: SkillEntry) {
        guard let insertion = mentions.insert(skill, into: draft.wrappedValue) else { return }
        draft.wrappedValue = insertion.text
        model.bindSkillChip(skill.name, at: insertion.cursor - ("$" + skill.name + " ").utf16.count, in: key)
        selection = NSRange(location: insertion.cursor, length: 0)
        focused = true
    }

    private var plusMenu: some View {
        let useSkill: (() -> Void)? = skillScope == nil ? nil : { insertTrigger("$") }
        let mentionAgent: (() -> Void)? = roles.isEmpty ? nil : { insertTrigger("@") }
        let camera: (() -> Void)? = UIImagePickerController.isSourceTypeAvailable(.camera)
            ? { presentAfterMenu { showCamera = true } } : nil
        return PlusMenu(
            connected: model.connected,
            acceptsImages: acceptsImages,
            modelName: currentModel?.name ?? currentModel?.modelId,
            canAddImages: tray.freeSlots > 0,
            attachFiles: model.hostSupports(.attachments)
                ? { presentAfterMenu { showFiles = true } } : nil,
            photos: { presentAfterMenu { showPhotos = true } },
            camera: camera,
            paste: { model.pasteImage(into: key, accepts: acceptsImages) },
            useSkill: useSkill,
            mentionAgent: mentionAgent
        )
    }

    /// An add entry's trigger at the caret; focusing opens its menu.
    private func insertTrigger(_ trigger: String) {
        let insertion = ComposerTrigger.insert(trigger, into: draft.wrappedValue, selection: selection)
        draft.wrappedValue = insertion.text
        selection = NSRange(location: insertion.cursor, length: 0)
        focused = true
    }

    private var homeLabel: String {
        switch model.draftHome {
        case .chat: return "No Project"
        case .project(let path):
            let name = projects.first { $0.path == path }?.name
            return name ?? (path as NSString).lastPathComponent
        }
    }

    /// Where the draft will run, floating above the card: one container so
    /// the checkout chip melts out of the project chip when a project is
    /// picked rather than popping in.
    private var location: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                projectMenu
                    .glassEffectID("home", in: chips)
                if case .project = model.draftHome {
                    // A long project name truncates; the checkout always reads.
                    checkoutMenu
                        .fixedSize()
                        .glassEffectID("checkout", in: chips)
                }
            }
        }
        .animation(.snappy(duration: 0.25), value: model.draftHome)
    }

    private var projectMenu: some View {
        Menu {
            Button("No Project", image: .messageCircle) { model.draftHome = .chat }
            if !projects.isEmpty {
                Section("Projects") {
                    ForEach(projects.indices, id: \.self) { index in
                        let project = projects[index]
                        if let path = project.path {
                            Button(project.name ?? (path as NSString).lastPathComponent, image: .folder) {
                                model.draftHome = .project(path: path)
                            }
                        }
                    }
                }
            }
            if model.hostSupports("listFolders") {
                Button("Add Project…", image: .folderPlus) {
                    model.navPath.append(.addProject)
                }
            }
        } label: {
            LocationChip(icon: model.draftHome == .chat ? .messageCircle : .folder, label: homeLabel)
        }
        .tint(.secondary)
        .disabled(!model.connected)
    }

    private var checkoutMenu: some View {
        Menu {
            Button("Git Worktree", image: .gitBranch) { model.draftCheckout = .worktree }
            Button("Project Folder", image: .monitor) { model.draftCheckout = .project }
        } label: {
            LocationChip(
                icon: model.draftCheckout == .worktree ? .gitBranch : .monitor,
                label: model.draftCheckout == .worktree ? "Git Worktree" : "Project Folder"
            )
        }
        .tint(.secondary)
        .disabled(!model.connected)
    }
}

/// A glass capsule naming where the draft will run.
private struct LocationChip: View {
    let icon: ImageResource
    let label: String

    var body: some View {
        Label(label, image: icon)
            .font(.footnote)
            .lineLimit(1)
            // Concrete color: on glass the hierarchical styles pick up
            // vibrancy and read as disabled grey.
            .foregroundStyle(Color(uiColor: .secondaryLabel))
            .padding(.horizontal, 12)
            .frame(height: 34)
            .glassEffect(.regular.interactive(), in: .capsule)
    }
}
