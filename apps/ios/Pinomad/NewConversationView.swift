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
    @State private var mentions = MentionCoordinator()
    @State private var selection = NSRange()
    @State private var focused = false

    private let key = AppModel.draftKey
    private var tray: AttachmentTray { model.trays[key] ?? AttachmentTray() }
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

    /// The picker stays up while a pick survives a now-empty snapshot so the
    /// reader can clear it (the web's rule); an empty roles list alone hides
    /// it. A pick that outlived a host downgrade also keeps the chip, with
    /// only "不指定" — otherwise there is no way back to a plain draft.
    private var showAgentPicker: Bool {
        selectedAgent != nil || (agentPickerAvailable && !roles.isEmpty)
    }

    /// An inherited side reads "来自 @name"; an overridden side drops it.
    private var sourceHint: String? {
        guard let agent = selectedAgent, let resolution else { return nil }
        let modelInherited = resolution.modelFrom != .override
        let levelInherited = resolution.levelFrom != .override
        if modelInherited && levelInherited { return "来自 @\(agent)" }
        if modelInherited { return "模型来自 @\(agent)" }
        if levelInherited { return "等级来自 @\(agent)" }
        return nil
    }

    /// The capsule's short red label and the card's full reason when the
    /// named-agent create would be refused.
    private var problemText: (label: String, reason: String)? {
        guard let problem = resolution?.problem else { return nil }
        switch problem {
        case let .agentMissing(agent, reason):
            let base = "这台宿主上没有具名 Agent @\(agent)"
            return ("@\(agent) 不可用", reason.map { base + "：\($0)" } ?? base)
        case let .modelMissing(agent):
            return ("@\(agent) 没有可用模型", "@\(agent) 没指定模型，宿主也没有默认模型")
        case let .modelUnavailable(agent, model, source):
            let name = "\(model.provider)/\(model.modelId)"
            let from: String
            switch source {
            case .agent: from = "@\(agent) 指定的模型"
            case .`default`: from = "宿主默认模型"
            case .override: from = "选中的模型"
            }
            return ("\(name) 不可用", "\(name)（\(from)）不在宿主的模型列表里")
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
            && resolution?.problem == nil
            && (!draft.wrappedValue.allSatisfy(\.isWhitespace) || !tray.images.isEmpty)
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("想让 Pi 做点什么？")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Spacer()
            if mentions.skillMenu.isShowing {
                SkillMenuView(menu: mentions.skillMenu, choose: chooseSkill)
            } else if mentions.menu.isShowing {
                MentionMenuView(menu: mentions.menu, choose: chooseMention)
            }
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .navigationTitle("新对话")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { focused = true }
        .onChange(of: draft.wrappedValue) { _, _ in refreshMentions() }
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
                onModel: { model.setDraftModel($0) },
                onLevel: { model.setDraftLevel($0) }
            )
        }
        .imageSources(model: model, key: key, accepts: acceptsImages,
                      showPhotos: $showPhotos, showCamera: $showCamera)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !tray.isEmpty || tray.error != nil || imagesBlocked {
                AttachmentStrip(
                    tray: tray,
                    note: imagesBlocked ? "\(currentModel?.name ?? "当前模型")不支持图片，移除图片或换模型后再发送" : tray.error,
                    // The create already took these; a change now would be
                    // lost when the draft clears.
                    remove: { if !model.creating { model.removeImage(conversation: key, at: $0) } },
                    view: { model.viewing = $0 }
                )
            }
            SkillComposerText(
                text: draft,
                selection: $selection,
                focused: $focused,
                placeholder: "想让 Pi 做什么…",
                names: skillEntries?.map(\.name),
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
                PlusMenu(
                    connected: model.connected,
                    acceptsImages: acceptsImages,
                    modelName: currentModel?.name ?? currentModel?.modelId,
                    canAddImages: tray.freeSlots > 0,
                    photos: { presentAfterMenu { showPhotos = true } },
                    camera: UIImagePickerController.isSourceTypeAvailable(.camera)
                        ? { presentAfterMenu { showCamera = true } } : nil,
                    paste: { model.pasteImage(into: key, accepts: acceptsImages) },
                    compact: nil
                )
                // Images added mid-create would miss the request and then be
                // cleared with the draft — hold the menu like the text field.
                .disabled(model.creating)
                ModelCapsule(
                    label: modelLabel(models: model.snapshot?.models ?? [], selected: pick),
                    enabled: model.connected && !(model.snapshot?.models.isEmpty ?? true),
                    sourceHint: sourceHint,
                    problem: problemText?.label
                ) {
                    focused = false
                    showModels = true
                }
                // Let the capsule take its ideal width; the spacer gives up
                // the room first so the model and source hint both read.
                .layoutPriority(1)
                Spacer(minLength: 0)
                if model.creating {
                    ProgressView().frame(width: 34, height: 34)
                } else {
                    Button {
                        Task { await model.createConversation() }
                    } label: {
                        SlotIcon(systemName: "arrow.up")
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel("开始对话")
                }
            }
            .frame(minHeight: 34)
            .sensoryFeedback(.impact(weight: .light), trigger: model.creating) { old, new in !old && new }
            HStack(spacing: 8) {
                projectMenu
                if case .project = model.draftHome {
                    checkoutMenu
                }
                if showAgentPicker {
                    agentMenu
                }
            }
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

    private func chooseSkill(_ skill: SkillEntry) {
        guard let insertion = mentions.insert(skill, into: draft.wrappedValue) else { return }
        draft.wrappedValue = insertion.text
        selection = NSRange(location: insertion.cursor, length: 0)
        focused = true
    }

    private var homeLabel: String {
        switch model.draftHome {
        case .chat: return "无项目"
        case .project(let path):
            let name = projects.first { $0.path == path }?.name
            return name ?? (path as NSString).lastPathComponent
        }
    }

    private var projectMenu: some View {
        Menu {
            Button("无项目", systemImage: "bubble.left") { model.draftHome = .chat }
            if !projects.isEmpty {
                Section("项目") {
                    ForEach(projects.indices, id: \.self) { index in
                        let project = projects[index]
                        if let path = project.path {
                            Button(project.name ?? (path as NSString).lastPathComponent, systemImage: "folder") {
                                model.draftHome = .project(path: path)
                            }
                        }
                    }
                }
            }
            if model.hostSupports("listFolders") {
                Button("添加项目…", systemImage: "folder.badge.plus") {
                    model.navPath.append(.addProject)
                }
            }
        } label: {
            LocationChip(icon: model.draftHome == .chat ? "bubble.left" : "folder", label: homeLabel)
        }
        .tint(.secondary)
        .disabled(!model.connected)
    }

    private var checkoutMenu: some View {
        Menu {
            Button("Git worktree", systemImage: "arrow.triangle.branch") { model.draftCheckout = .worktree }
            Button("项目目录", systemImage: "desktopcomputer") { model.draftCheckout = .project }
        } label: {
            LocationChip(
                icon: model.draftCheckout == .worktree ? "arrow.triangle.branch" : "desktopcomputer",
                label: model.draftCheckout == .worktree ? "Git worktree" : "项目目录"
            )
        }
        .tint(.secondary)
        .disabled(!model.connected)
    }

    /// The draft's named agent (ADR-0023). A fixed order keeps "不指定"
    /// above the section however the menu lays itself out around the chip.
    /// Toggle supplies the checkmark; two Texts make the description a
    /// subtitle in the menu.
    private var agentMenu: some View {
        Menu {
            Toggle("不指定", isOn: Binding(
                get: { selectedAgent == nil },
                set: { isOn in if isOn { model.setDraftAgent(nil) } }
            ))
            if agentPickerAvailable && !roles.isEmpty {
                Section("具名 Agent") {
                    ForEach(roles, id: \.name) { role in
                        Toggle(isOn: Binding(
                            get: { selectedAgent == role.name },
                            set: { isOn in if isOn { model.setDraftAgent(role.name) } }
                        )) {
                            Text("@\(role.name)")
                            if !role.description.isEmpty {
                                Text(role.description)
                            }
                        }
                    }
                }
            }
        } label: {
            LocationChip(icon: "person.crop.circle",
                         label: selectedAgent.map { "@\($0)" } ?? "Agent")
        }
        .menuOrder(.fixed)
        .tint(.secondary)
        .disabled(!model.connected || model.creating)
    }
}

/// A small capsule naming where the draft will run.
private struct LocationChip: View {
    let icon: String
    let label: String

    var body: some View {
        Label(label, systemImage: icon)
            .font(.caption)
            .lineLimit(1)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.fill.tertiary, in: .capsule)
    }
}
