import PinomadCore
import SwiftUI
import UIKit

/// How a computer joins this account (#497), shared by the first-host home
/// and Account → Add a Host: the tokenless command to run there, the field
/// for the code it then shows, and the one-use token command behind
/// Advanced for a host that has to join without anyone confirming.
struct AddAccountHostContent: View {
    let model: AppModel

    var body: some View {
        if let session = model.accountSession {
            VStack(alignment: .leading, spacing: 20) {
                JoinCommandBlock(command: HostLinkCopy.joinCommand(serverOrigin: session.serverOrigin))

                VStack(alignment: .leading, spacing: 10) {
                    Text("It installs PiNomad and shows a code. Enter it here to add the host to your account:")
                        .foregroundStyle(.secondary)
                    HostLinkCodeEntry(model: model)
                }

                Text("The host then keeps running as a service, shows up here and connects on its own.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                OneTimeTokenDisclosure(model: model)
            }
        }
    }
}

/// A command to run on another computer, ready to copy or send there.
struct JoinCommandBlock: View {
    let command: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(command)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.fill.tertiary, in: .rect(cornerRadius: 12))

            HStack(spacing: 12) {
                Button {
                    UIPasteboard.general.string = command
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", image: copied ? .check : .copy)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.tactile(.glass))
                .sensoryFeedback(.success, trigger: copied)

                // AirDrop, Messages or Mail to the computer that will run it.
                ShareLink(item: command) {
                    Label("Share", image: .share)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.tactile(.glass))
            }
            .controlSize(.large)
        }
        .onChange(of: command) { copied = false }
    }
}

/// The field for the code a joining host shows. Typed by hand only: no
/// link fills it and the pasteboard isn't read for it, so confirming a
/// code someone sent takes a deliberate act. The confirm page opens once
/// the server says a host is waiting behind it.
struct HostLinkCodeEntry: View {
    let model: AppModel

    @State private var flow = HostLinkFlow()
    @State private var text = ""
    @FocusState private var focused: Bool

    private var lookingUp: Bool {
        if case .lookingUp = flow.step { true } else { false }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                // Its own text, rewritten in onChange: a binding whose setter
                // reformats doesn't redraw the field.
                TextField("XXXX-XXXX", text: $text)
                    .font(.system(.title3, design: .monospaced, weight: .medium))
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .submitLabel(.continue)
                    .onSubmit { Task { await lookUp() } }
                    .focused($focused)
                    .disabled(lookingUp)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 12))
                    .accessibilityLabel("Code shown on the host")

                Button {
                    Task { await lookUp() }
                } label: {
                    if lookingUp {
                        ProgressView()
                    } else {
                        Text("Continue")
                    }
                }
                .buttonStyle(.tactile(.glassProminent))
                .controlSize(.large)
                .disabled(!flow.canLookUp)
            }

            if let error = flow.error, flow.request == nil {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .onChange(of: text) { _, typed in
            flow.type(typed)
            if text != flow.input { text = flow.input }
        }
        // Starting over empties the field.
        .onChange(of: flow.input) { _, input in
            if text != input { text = input }
        }
        .sheet(isPresented: Binding(
            get: { flow.request != nil },
            // Swiped away unanswered: the code waits on the server until it
            // expires, and the field starts over.
            set: { if !$0 { flow.startOver() } }
        )) {
            HostLinkConfirmView(model: model, flow: $flow)
        }
        #if DEBUG
        .task {
            guard let code = model.devHostLinkCode else { return }
            model.devHostLinkCode = nil
            text = code
            flow.type(code)
            await lookUp()
            guard model.devHostLinkConfirms, let request = flow.request,
                  let code = flow.beginConfirm(now: .now) else { return }
            model.devHostLinkConfirms = false
            flow.confirmFinished(code: code, await model.accountConfirmHostLink(code, hostId: request.hostId))
        }
        #endif
    }

    private func lookUp() async {
        guard let code = flow.beginLookup() else { return }
        focused = false
        flow.lookupFinished(code: code, await model.accountLookupHostLink(code))
    }
}

/// What the server knows about the host behind a code, to tell a computer
/// you're setting up from one someone else started: its name, system, the
/// address it asked from and its id, which `pinomad join` printed in full.
/// Confirm joins it to the account, and from there it pairs with every
/// device on its own.
struct HostLinkConfirmView: View {
    let model: AppModel
    @Binding var flow: HostLinkFlow

    @State private var copiedId = false

    private var busy: Bool {
        switch flow.step {
        case .confirming, .denying: true
        default: false
        }
    }

    private var settled: Bool {
        switch flow.step {
        case .joined, .denied: true
        default: false
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let request = flow.request {
                    switch flow.step {
                    case .joined:
                        settled(
                            icon: .circleCheck, tint: .green,
                            title: "\(displayName(request)) joined your account",
                            detail: "The host will appear and connect on its own.")
                    case .denied:
                        settled(
                            icon: .circleX, tint: .secondary,
                            title: "Join denied",
                            detail: "\(displayName(request)) won't be added to your account.")
                    default:
                        review(request)
                    }
                }
            }
            .navigationTitle("Add a Host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Settled, the page's own Done closes it.
                if !settled {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { flow.startOver() }
                            .disabled(busy)
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
        .sensoryFeedback(.success, trigger: flow.step) { _, new in
            if case .joined = new { true } else { false }
        }
    }

    private func displayName(_ request: HostLinkRequest) -> String {
        request.name.isEmpty ? "The host" : request.name
    }

    private func review(_ request: HostLinkRequest) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text(request.name.isEmpty ? "Add this host to your account?" : "Add \(request.name) to your account?")
                    .font(.title2.weight(.semibold))
                Text(HostLinkCopy.warning)
                    .foregroundStyle(.secondary)
            }

            if request.ipDiffers {
                Label {
                    Text(HostLinkCopy.ipDiffersWarning)
                } icon: {
                    Image(.triangleAlert)
                }
                .font(.callout.weight(.medium))
                .foregroundStyle(.orange)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 12))
            }

            details(request)

            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = PairingCodeCopy.remainingSeconds(expiresAt: request.expiresAt, now: context.date)
                if seconds == 0 {
                    Text("This code expired. Run pinomad join on the host again for a new one.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                } else {
                    Text("Code expires in \(PairingCodeCopy.countdown(seconds))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            if let error = flow.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 12) {
                    Button {
                        Task { await deny() }
                    } label: {
                        Group {
                            if case .denying = flow.step { ProgressView() } else { Text("Deny") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glass))
                    .disabled(busy)

                    Button {
                        Task { await confirm(request) }
                    } label: {
                        Group {
                            if case .confirming = flow.step { ProgressView() } else { Text("Confirm") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tactile(.glassProminent))
                    .disabled(!flow.canConfirm(now: context.date))
                }
                .controlSize(.large)
            }
            .padding(.top, 4)
        }
        .padding(20)
    }

    private func details(_ request: HostLinkRequest) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 12) {
            row("Name", request.name.isEmpty ? "—" : request.name)
            row("System", request.os.isEmpty ? "—" : request.os)
            GridRow {
                label("Requested from")
                Text(request.sourceIp.isEmpty ? "—" : request.sourceIp)
                    .font(.body.monospaced())
                    .foregroundStyle(request.ipDiffers ? .orange : .primary)
            }
            GridRow {
                label("Host ID")
                HStack(spacing: 8) {
                    Text(HostLinkCopy.shortHostId(request.hostId))
                        .font(.body.monospaced())
                        .accessibilityLabel("Host ID \(request.hostId)")
                    Button {
                        UIPasteboard.general.string = request.hostId
                        copiedId = true
                    } label: {
                        Image(copiedId ? .check : .copy)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(copiedId ? "Copied" : "Copy the full host ID")
                    .sensoryFeedback(.success, trigger: copiedId)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.tertiary, in: .rect(cornerRadius: 12))
    }

    private func row(_ title: String, _ value: String) -> some View {
        GridRow {
            label(title)
            Text(value)
        }
    }

    private func label(_ title: String) -> some View {
        Text(title)
            .foregroundStyle(.secondary)
            .gridColumnAlignment(.leading)
    }

    private func settled(icon: ImageResource, tint: Color, title: String, detail: String) -> some View {
        VStack(spacing: 14) {
            Image(icon)
                .font(.system(size: 44))
                .foregroundStyle(tint)
            Text(title)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(detail)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                flow.startOver()
            } label: {
                Text("Done").frame(maxWidth: .infinity)
            }
            .buttonStyle(.tactile(.glassProminent))
            .controlSize(.large)
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 48)
    }

    private func confirm(_ request: HostLinkRequest) async {
        guard let code = flow.beginConfirm(now: .now) else { return }
        flow.confirmFinished(code: code, await model.accountConfirmHostLink(code, hostId: request.hostId))
    }

    private func deny() async {
        guard let code = flow.beginDeny() else { return }
        flow.denyFinished(code: code, await model.accountDenyHostLink(code))
    }
}

/// The one-use `pinomad join … <token>` command, for a host that joins
/// without anyone confirming a code. Minted only once this is opened, and
/// kept while it is closed again: each command works once.
struct OneTimeTokenDisclosure: View {
    let model: AppModel

    @State private var expanded = false
    @State private var token: JoinToken?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                Text("This command joins the host without a code, for a computer you set up from a script. It works once.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                command
            }
            .padding(.top, 10)
            .task {
                if token == nil && error == nil { await create() }
            }
        } label: {
            Text("Advanced: join with a one-time token")
                .font(.subheadline)
        }
    }

    @ViewBuilder
    private var command: some View {
        if let token {
            VStack(alignment: .leading, spacing: 12) {
                JoinCommandBlock(command: token.command)

                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = PairingCodeCopy.remainingSeconds(expiresAt: token.expiresAt, now: context.date)
                    if seconds == 0 {
                        HStack(spacing: 12) {
                            Text("Expired")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button("New command") { Task { await create() } }
                                .buttonStyle(.tactile(.bordered))
                                .controlSize(.small)
                                .disabled(busy)
                        }
                    } else {
                        Text("Works once · expires in \(PairingCodeCopy.countdown(seconds))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }

                if let error {
                    Text("Couldn't create a new command. \(error)")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        } else if let error {
            VStack(alignment: .leading, spacing: 10) {
                Text("Couldn't create a join command. \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Try again") { Task { await create() } }
                    .buttonStyle(.tactile(.bordered))
                    .disabled(busy)
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Creating a command…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func create() async {
        busy = true
        error = nil
        let result = await model.accountCreateJoinToken()
        busy = false
        switch result {
        case .success(let value): token = value
        case .failure(let failure): error = AccountCopy.message(failure)
        }
    }
}

/// Account → Add a Host: the same ways in as the first-host home.
struct AddAccountHostView: View {
    let model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("A host is the computer that runs your agents: a Mac or Linux machine with Node 25 or later. Open a terminal there and run:")
                    .foregroundStyle(.secondary)
                AddAccountHostContent(model: model)
            }
            .padding(20)
        }
        .navigationTitle("Add a Host")
        .navigationBarTitleDisplayMode(.inline)
    }
}
