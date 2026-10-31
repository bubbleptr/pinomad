import PinomadCore
import SwiftUI

/// The home page: the family statuses of every machine as four tiles, then
/// every paired machine with its Chats and projects — each a page of its
/// own, so the page stays short however many conversations there are. All
/// machines are live at once (#429): each group reads its own host's view
/// and shows its own state; nothing here moves the focus.
struct ConversationListView: View {
    let model: AppModel

    @State private var query = ""

    var body: some View {
        let roots = model.machineRoots
        List {
            if !model.lastError.isEmpty {
                // Platform failures (e.g. the keychain rejecting a pairing
                // write) are not fatal to the connection, but must be
                // visible — a toast would lose them.
                Label(model.lastError, image: .triangleAlert)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .listRowBackground(Color.clear)
            }
            if !query.isEmpty {
                searchResults(roots)
            } else {
                if model.machines.contains(where: { model.runtimes[$0.hostKey]?.snapshot != nil }) {
                    StatusTiles(roots: roots.map(\.node)) { filter in
                        model.navPath.append(.conversations(hostKey: nil, filter: filter))
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
                ForEach(model.machines, id: \.hostKey) { host in
                    Section {
                        MachineGroup(model: model, hostKey: host.hostKey)
                    } header: {
                        MachineHeader(
                            label: model.machineLabel(host.hostKey),
                            online: model.isConnected(host.hostKey)
                        )
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.systemGroupedBackground))
        .overlay {
            if !query.isEmpty, !roots.contains(where: { matches($0.node) }) {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search conversations")
        .navigationDestination(for: Route.self) { route in
            RouteDestination(model: model, route: route)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.present(.account)
                } label: {
                    // The live session, not the remembered record: after a
                    // sign-out the record keeps the name only to prefill login.
                    AccountBadge(username: model.accountSession?.username)
                }
                .accessibilityLabel(model.accountSession.map { "Account: \($0.username)" } ?? "Account")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", image: .settings) {
                    model.navPath.append(.settings)
                }
            }
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                // The draft of the machine last shown; its page offers the
                // others.
                Button("New", image: .squarePen) {
                    guard let hostKey = model.currentHostKey else { return }
                    model.navPath.append(.newConversation(hostKey: hostKey))
                }
                .disabled(!model.connected)
            }
        }
    }

    /// While searching, the matching roots of every machine replace the
    /// groups.
    @ViewBuilder
    private func searchResults(_ roots: [MachineRoot]) -> some View {
        let results = roots.filter { matches($0.node) }
        ForEach(results) { entry in
            if let ref = entry.ref {
                NavigationLink(value: Route.conversation(ref)) {
                    ConversationRowLabel(node: entry.node, project: model.rowSubtitle(entry))
                }
                .quietSeparator()
                // Rules only between results, as on the conversations pages.
                .listRowSeparator(.hidden, edges: .top)
                .listRowSeparator(entry.id == results.last?.id ? .hidden : .automatic, edges: .bottom)
                .listRowBackground(Color.clear)
            }
        }
    }

    private func matches(_ node: ConversationNode) -> Bool {
        displayName(summary: node.summary).localizedCaseInsensitiveContains(query)
    }
}

/// One machine's rows under its header: its groups once it has a view, a
/// skeleton while it connects, or why it can't be used.
private struct MachineGroup: View {
    let model: AppModel
    let hostKey: String

    var body: some View {
        let runtime = model.runtimes[hostKey]
        if case .failed(let failure)? = runtime?.phase {
            NavigationLink(value: Route.machineUnavailable(hostKey)) {
                HStack(spacing: 12) {
                    Image(.cloudOff)
                        .font(.body)
                        .frame(width: 28)
                    Text(failure.title)
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
                .padding(.vertical, 6)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden, edges: .bottom)
        } else if let organized = runtime?.snapshot?.organized {
            groups(organized, connected: runtime?.isConnectedNow ?? false)
        } else {
            GroupRowsSkeleton()
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }

    @ViewBuilder
    private func groups(_ organized: Organized, connected: Bool) -> some View {
        // The folder picker needs listFolders (protocol 5.3); an older
        // host gets no add row, and its last project ends the group.
        let canAdd = model.hostSupports("listFolders", on: hostKey)
        let projects = organized.projects.compactMap { group in
            group.project.path.map { (path: $0, group: group) }
        }
        if !organized.chats.isEmpty {
            groupRow(.chats, title: "Chats", image: .messageCircle,
                     count: organized.chats.count, endsGroup: !canAdd && projects.isEmpty)
        }
        ForEach(Array(projects.enumerated()), id: \.offset) { index, entry in
            groupRow(.project(entry.path), title: entry.group.project.name ?? entry.path,
                     image: .folder, count: entry.group.conversations.count,
                     endsGroup: !canAdd && index == projects.count - 1)
        }
        if canAdd {
            Button {
                model.navPath.append(.addProject(hostKey: hostKey))
            } label: {
                Label("Add project", image: .plus)
                    .foregroundStyle(.secondary)
            }
            .disabled(!connected)
            .listRowBackground(Color.clear)
            // Ends the machine's group; the next header separates it.
            .listRowSeparator(.hidden, edges: .bottom)
        }
    }

    private func groupRow(
        _ filter: ConversationFilter, title: String, image: ImageResource, count: Int, endsGroup: Bool
    ) -> some View {
        NavigationLink(value: Route.conversations(hostKey: hostKey, filter: filter)) {
            HStack(spacing: 12) {
                Image(image)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                Text(title)
                    .lineLimit(1)
                Spacer()
                Text("\(count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(.vertical, 6)
            .shortSeparator()
        }
        .quietSeparator()
        .listRowSeparator(endsGroup ? .hidden : .automatic, edges: .bottom)
        .listRowBackground(Color.clear)
    }
}

/// A root with the machine it lives on, for lists that mix machines.
struct MachineRoot: Identifiable {
    let hostKey: String
    let node: ConversationNode
    /// The project's name; nil for a Chat.
    let project: String?

    var ref: ConversationRef? {
        node.summary.id.map { ConversationRef(hostKey: hostKey, conversationId: $0) }
    }

    var id: String { "\(hostKey):\(node.summary.id.map(String.init) ?? "-")" }
}

extension AppModel {
    /// The line under a root's title in a list that mixes groups: its
    /// project, led by its machine once there is more than one to tell
    /// apart.
    func rowSubtitle(_ entry: MachineRoot) -> String? {
        guard machines.count > 1 else { return entry.project }
        return [machineLabel(entry.hostKey), entry.project].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Every root on the machine with the project it belongs to (nil for a
/// Chat) — the tiles count them and the filter pages list them.
func allRoots(_ organized: Organized) -> [(node: ConversationNode, project: String?)] {
    organized.chats.map { ($0, nil) }
        + organized.projects.flatMap { group in
            group.conversations.map { ($0, group.project.name ?? group.project.path) }
        }
}

/// A machine's section header: its name and connection dot — the only
/// place the app shows host state (#252).
private struct MachineHeader: View {
    let label: String
    let online: Bool

    var body: some View {
        HStack(spacing: 8) {
            // Concrete colors: a section header dims hierarchical styles.
            // The icon matches the group rows' icons below it.
            Image(.monitor)
                .font(.body)
                .foregroundStyle(Color(.secondaryLabel))
            Text(label)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color(.label))
                .lineLimit(1)
            ConnectionDot(online: online)
                .accessibilityLabel(online ? "Connected" : "Not connected")
        }
        .textCase(nil)
        .padding(.top, 8)
    }
}

/// Green and breathing while connected, grey otherwise — the only place
/// the app shows host state (#252).
struct ConnectionDot: View {
    let online: Bool

    var body: some View {
        Circle()
            .fill(online ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 10, height: 10)
            .phaseAnimator(online ? [1.0, 0.35] : [1.0]) { dot, opacity in
                dot.opacity(opacity)
            } animation: { _ in .easeInOut(duration: 1.2) }
    }
}

/// The four family statuses as tiles; each opens its filtered list.
private struct StatusTiles: View {
    let roots: [ConversationNode]
    let open: (ConversationFilter) -> Void

    var body: some View {
        let statuses = roots.map { familyStatus(node: $0) }
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                tile(.all, count: nil)
                tile(.needsAnswer, count: statuses.filter { $0 == .needsAnswer }.count)
            }
            GridRow {
                tile(.running, count: statuses.filter { $0 == .running }.count)
                tile(.failed, count: statuses.filter { $0 == .failed }.count)
            }
        }
    }

    private func tile(_ filter: ConversationFilter, count: Int?) -> some View {
        Button {
            open(filter)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Image(filter.image)
                    .font(.title2)
                    .foregroundStyle(filter.tint)
                    .symbolEffect(.pulse, isActive: filter == .running && (count ?? 0) > 0)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(filter.title)
                        .foregroundStyle(.primary)
                    if let count {
                        Text("\(count)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                .font(.body.weight(.medium))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .frame(height: 104, alignment: .bottomLeading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(Color(.separator), lineWidth: 0.5) }
            .contentShape(.rect(cornerRadius: 22))
        }
        .buttonStyle(.press)
    }
}

/// The account in the toolbar: the username's initial in a circle when it
/// has a symbol (a–z, 0–9), else the generic person. A symbol, not text, so
/// the toolbar's glass stays a circle like the trailing buttons.
private struct AccountBadge: View {
    let username: String?

    var body: some View {
        if let initial {
            Image(systemName: "\(initial).circle")
        } else {
            Image(.userRound)
        }
    }

    private var initial: String? {
        guard let initial = username?.first?.lowercased(), initial.count == 1,
              let scalar = initial.unicodeScalars.first, scalar.isASCII,
              CharacterSet.alphanumerics.contains(scalar)
        else { return nil }
        return initial
    }
}
