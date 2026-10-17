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
    @FocusState private var focused: Bool

    private let key = AppModel.draftKey
    private var tray: AttachmentTray { model.trays[key] ?? AttachmentTray() }
    private var pick: ModelPick { model.effectiveDraftPick }
    private var currentModel: ModelSummary? { summaryOf(models: model.snapshot?.models ?? [], model: pick.model) }
    private var acceptsImages: Bool { currentModel?.images == true }
    private var imagesBlocked: Bool { !acceptsImages && !tray.images.isEmpty }
    private var projects: [Project] { model.snapshot?.organized.projects.map(\.project) ?? [] }

    private var draft: Binding<String> {
        Binding(get: { model.drafts[key] ?? "" }, set: { model.drafts[key] = $0 })
    }

    private var canSend: Bool {
        model.connected && !model.creating && tray.preparing == 0 && !imagesBlocked
            && (!draft.wrappedValue.allSatisfy(\.isWhitespace) || !tray.images.isEmpty)
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("想让 Pi 做点什么？")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Spacer()
            card
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .navigationTitle("新对话")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { focused = true }
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
            TextField("想让 Pi 做什么…", text: draft, axis: .vertical)
                .lineLimit(3...8)
                .focused($focused)
                .disabled(!model.connected || model.creating)
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
                    enabled: model.connected && !(model.snapshot?.models.isEmpty ?? true)
                ) {
                    focused = false
                    showModels = true
                }
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
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
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
