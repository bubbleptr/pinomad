import PinomadChat
import PinomadCore
import SwiftUI

/// The host folder picker: walks the host's filesystem one folder at a time
/// (starting at the host user's home), registers the shown folder as a
/// project, and goes back to the draft with it selected.
struct AddProjectView: View {
    let model: AppModel

    @State private var browser = FolderBrowser()
    @State private var adding = false
    @State private var addError: String?

    private var listing: FolderListing? { browser.listing }

    var body: some View {
        List {
            if let listing {
                Section {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal) {
                            HStack(spacing: 4) {
                                let crumbs = folderCrumbs(path: listing.path, home: listing.home)
                                ForEach(crumbs.indices, id: \.self) { index in
                                    if index > 0 {
                                        Image(.chevronRight)
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                    Button(crumbs[index].label) { go(crumbs[index].path) }
                                        .buttonStyle(.press)
                                        .font(.footnote)
                                        .foregroundStyle(index == crumbs.count - 1 ? .primary : .secondary)
                                        .id(index)
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                        // A navigation lands at the trail's tail — keep it in view.
                        .onAppear { proxy.scrollTo(crumbCount(listing) - 1, anchor: .trailing) }
                        .onChange(of: listing.path) { _, _ in
                            proxy.scrollTo(crumbCount(listing) - 1, anchor: .trailing)
                        }
                    }
                }
            }
            Section {
                if browser.loading && listing == nil {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let error = browser.error {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).foregroundStyle(.red).font(.footnote)
                        Button("再试一次") { go(browser.retryPath) }
                    }
                } else if let listing, listing.folders.isEmpty {
                    Text("没有子目录").foregroundStyle(.secondary)
                } else if let listing {
                    ForEach(listing.folders, id: \.path) { folder in
                        Button {
                            go(folder.path)
                        } label: {
                            Label(folder.name, image: .folder)
                                .foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .tint(.primary)
        .disabled(adding)
        .navigationTitle("添加项目")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if let listing, let up = parentFolder(path: listing.path) {
                    Button("上一级", image: .arrowUp) { go(up) }
                        .disabled(adding)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { footer }
        .task { if listing == nil { go(nil) } }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let addError {
                Text(addError).font(.footnote).foregroundStyle(.red)
            } else if let listing {
                Text(listing.path)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.head)
            }
            Button {
                add()
            } label: {
                Group {
                    if adding { ProgressView() } else { Text("添加为项目") }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.borderedProminent))
            .controlSize(.large)
            .disabled(listing == nil || browser.loading || adding || !model.connected)
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .padding(.horizontal, 12)
    }

    private func crumbCount(_ listing: FolderListing) -> Int {
        folderCrumbs(path: listing.path, home: listing.home).count
    }

    private func go(_ path: String?) {
        addError = nil
        let token = browser.go(to: path)
        Task {
            do {
                browser.land(token, try await model.listFolders(path))
            } catch {
                browser.fail(token, model.describe(error))
            }
        }
    }

    private func add() {
        guard let path = listing?.path else { return }
        adding = true
        addError = nil
        Task {
            do {
                try await model.addProject(path)
                // Back to the draft, now set to this project.
                if model.navPath.last == .addProject { model.navPath.removeLast() }
            } catch {
                addError = model.describe(error)
            }
            adding = false
        }
    }
}
