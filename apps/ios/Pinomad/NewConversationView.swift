import PinomadChat
import PinomadCore
import SwiftUI
import UIKit

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
    @FocusState private var focused: Bool

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

    /// The picker stays up while a pick survives a now-empty snapshot so the
    /// reader can clear it (the web's rule); an empty roles list alone hides
    /// it.
    private var showAgentPicker: Bool {
        model.hostSupports(.agentConversations) && (!roles.isEmpty || selectedAgent != nil)
    }

    /// The capsule's label. While the source hint shares the line, the
    /// level suffix is dropped so the model and the hint both stay legible;
    /// the sheet still shows the level.
    private var capsuleLabel: String {
        guard sourceHint != nil, let currentModel else {
            return modelLabel(models: model.snapshot?.models ?? [], selected: pick)
        }
        return currentModel.name ?? currentModel.modelId
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
            if mentions.menu.isShowing {
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
        .onChange(of: mentions.selection) { _, _ in refreshMentions() }
        .onChange(of: roles) { _, _ in refreshMentions() }
        .onChange(of: model.draftHome) { _, _ in refreshMentions() }
        .onChange(of: model.draftCheckout) { _, _ in refreshMentions() }
        .onChange(of: model.hostSupports("listFiles")) { _, _ in refreshMentions() }
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
            TextField(
                "想让 Pi 做什么…", text: draft,
                selection: $mentions.selection, axis: .vertical
            )
            .lineLimit(3...8)
            .focused($focused)
            .disabled(!model.connected || model.creating)
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
                    label: capsuleLabel,
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
            HStack(spacing: 8) {
                projectMenu
                if case .project = model.draftHome {
                    checkoutMenu
                }
                if showAgentPicker {
                    AgentMenuChip(roles: roles, selected: selectedAgent,
                                  enabled: model.connected && !model.creating) {
                        model.setDraftAgent($0)
                    }
                }
            }
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
}

/// The draft's named agent (ADR-0023): "不指定" or one of the host's roles,
/// with each role's description as a menu subtitle. SwiftUI's Menu flattens
/// a view label and drops the description, and reorders a bare button below
/// the section, so the chip drives a UIMenu directly.
private struct AgentMenuChip: UIViewRepresentable {
    let roles: [AgentRole]
    let selected: String?
    let enabled: Bool
    let choose: (String?) -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.showsMenuAsPrimaryAction = true
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "person.crop.circle",
                              withConfiguration: UIImage.SymbolConfiguration(textStyle: .caption1))
        config.imagePadding = 4
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
        config.baseForegroundColor = .secondaryLabel
        config.background.backgroundColor = .tertiarySystemFill
        config.background.cornerRadius = 13
        config.titleLineBreakMode = .byTruncatingTail
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = UIFont.preferredFont(forTextStyle: .caption1)
            return outgoing
        }
        button.configuration = config
        button.titleLabel?.lineBreakMode = .byTruncatingTail
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        var config = button.configuration ?? .plain()
        config.title = selected.map { "@\($0)" } ?? "Agent"
        button.configuration = config
        button.isEnabled = enabled
        button.accessibilityLabel = selected.map { "Agent：@\($0)" } ?? "Agent"
        button.menu = menu()
        button.invalidateIntrinsicContentSize()
    }

    /// A UIViewRepresentable otherwise stretches to the proposal when the
    /// button has no intrinsic width yet; keep it a chip-sized control.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIButton, context: Context) -> CGSize? {
        let fitted = uiView.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude,
                                               height: CGFloat.greatestFiniteMagnitude))
        return CGSize(width: min(fitted.width, 220), height: 28)
    }

    private func menu() -> UIMenu {
        let none = UIAction(title: "不指定", state: selected == nil ? .on : .off) { _ in
            choose(nil)
        }
        // UIKit renders inline submenus in reverse declaration order and a
        // bare action after them; a non-empty title is what makes this sort
        // as a section instead. The space keeps that header visually blank.
        let unassigned = UIMenu(title: " ", options: .displayInline, children: [none])
        guard !roles.isEmpty else { return UIMenu(children: [unassigned]) }
        let actions = roles.map { role in
            let action = UIAction(title: "@\(role.name)", state: selected == role.name ? .on : .off) { _ in
                choose(role.name)
            }
            action.subtitle = role.description.isEmpty ? nil : role.description
            return action
        }
        return UIMenu(children: [
            UIMenu(title: "具名 Agent", options: .displayInline, children: actions),
            unassigned,
        ])
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
