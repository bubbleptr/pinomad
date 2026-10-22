import PinomadCore
import SwiftUI

/// The home page: the family statuses as four tiles, then every paired
/// machine with its Chats and projects — each a page of its own, so the
/// page stays short however many conversations there are. One connection
/// at a time (#148): another machine's groups are unknown until it is the
/// one connected, so it shows as a row that connects it.
struct ConversationListView: View {
    let model: AppModel

    @State private var query = ""

    var body: some View {
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
            if !query.isEmpty, let organized = model.snapshot?.organized {
                searchResults(organized)
            } else {
                if let organized = model.snapshot?.organized {
                    StatusTiles(roots: allRoots(organized).map(\.node)) { filter in
                        model.navPath.append(.conversations(filter))
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
                ForEach(machines, id: \.hostKey) { host in
                    Section {
                        if host.hostKey == model.currentHostKey {
                            currentMachine
                        } else {
                            Button {
                                model.switchHost(host.hostKey)
                            } label: {
                                Label("未连接，轻点连接", image: .unplug)
                                    .foregroundStyle(.secondary)
                            }
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden, edges: .bottom)
                        }
                    } header: {
                        MachineHeader(
                            label: label(host),
                            online: host.hostKey == model.currentHostKey
                                && model.snapshot?.connection == .connected
                        )
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.systemGroupedBackground))
        .overlay {
            if !query.isEmpty, let organized = model.snapshot?.organized,
               !allRoots(organized).contains(where: { matches($0.node) }) {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "搜索对话")
        .navigationDestination(for: Route.self) { route in
            RouteDestination(model: model, route: route)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.present(.account)
                } label: {
                    AccountBadge(username: model.accountRecord?.username)
                }
                .accessibilityLabel(model.accountRecord.map { "账号：\($0.username)" } ?? "账号")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("设置", image: .settings) {
                    model.navPath.append(.settings)
                }
            }
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button("新建", image: .squarePen) {
                    model.navPath.append(.newConversation)
                }
                .disabled(!model.connected)
            }
        }
        .safeAreaInset(edge: .top) { ConnectionBanner(model: model) }
    }

    /// Every paired machine in stored order — positions do not jump when
    /// the connection moves — plus a host a pairing just made that the
    /// keychain failed to keep.
    private var machines: [HostRecord] {
        var hosts = model.hosts.hosts
        if let session = model.sessionHost, !hosts.contains(where: { $0.hostKey == session.hostKey }) {
            hosts.insert(session, at: 0)
        }
        return hosts
    }

    private func label(_ host: HostRecord) -> String {
        model.hostLabels[host.hostKey] ?? host.name ?? hostOf(host.url)
    }

    @ViewBuilder
    private var currentMachine: some View {
        if let organized = model.snapshot?.organized {
            // The folder picker needs listFolders (protocol 5.3); an older
            // host gets no add row, and its last project ends the group.
            let canAdd = model.hostSupports("listFolders")
            let projects = organized.projects.compactMap { group in
                group.project.path.map { (path: $0, group: group) }
            }
            if !organized.chats.isEmpty {
                groupRow(.chats, title: "对话", image: .messagesSquare,
                         count: organized.chats.count, endsGroup: !canAdd && projects.isEmpty)
            }
            ForEach(Array(projects.enumerated()), id: \.offset) { index, entry in
                groupRow(.project(entry.path), title: entry.group.project.name ?? entry.path,
                         image: .folder, count: entry.group.conversations.count,
                         endsGroup: !canAdd && index == projects.count - 1)
            }
            if canAdd {
                Button {
                    model.navPath.append(.addProject)
                } label: {
                    Label("添加项目", image: .plus)
                        .foregroundStyle(.secondary)
                }
                .disabled(!model.connected)
                .listRowBackground(Color.clear)
                // Ends the machine's group; the next header separates it.
                .listRowSeparator(.hidden, edges: .bottom)
            }
        } else {
            GroupRowsSkeleton()
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }

    /// While searching, the matching roots of the connected machine replace
    /// the groups.
    @ViewBuilder
    private func searchResults(_ organized: Organized) -> some View {
        let results = allRoots(organized).filter { matches($0.node) }
        ForEach(results, id: \.node.summary.id) { entry in
            if let id = entry.node.summary.id {
                NavigationLink(value: Route.conversation(id)) {
                    ConversationRowLabel(node: entry.node, project: entry.project)
                }
                .quietSeparator()
                // Rules only between results, as on the conversations pages.
                .listRowSeparator(.hidden, edges: .top)
                .listRowSeparator(id == results.last?.node.summary.id ? .hidden : .automatic, edges: .bottom)
                .listRowBackground(Color.clear)
            }
        }
    }

    private func matches(_ node: ConversationNode) -> Bool {
        displayName(summary: node.summary).localizedCaseInsensitiveContains(query)
    }

    private func groupRow(
        _ filter: ConversationFilter, title: String, image: ImageResource, count: Int, endsGroup: Bool
    ) -> some View {
        NavigationLink(value: Route.conversations(filter)) {
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
            Image(.monitor)
                .foregroundStyle(.secondary)
            Text(label)
                .font(.title3.weight(.semibold))
                // A concrete color: a section header dims hierarchical styles.
                .foregroundStyle(Color(.label))
                .lineLimit(1)
            ConnectionDot(online: online)
                .accessibilityLabel(online ? "已连接" : "未连接")
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
            Image(.circleUser)
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
