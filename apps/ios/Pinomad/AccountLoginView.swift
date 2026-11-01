import PinomadCore
import SwiftUI

/// Sign in to the one account (ADR-0022): address first, probe, then the
/// credentials. The probe is the only thing that leaves the device before a
/// login, and an insecure address never leaves it at all. The root of the
/// account sheet while signed out; a successful login swaps that sheet to
/// the account's hosts.
///
/// The address starts at the last server signed in to, or the official one,
/// and is probed on appear so the form opens on the credentials.
struct AccountLoginView: View {
    /// The hosted PiNomad server; self-hosters change the address.

    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var origin: String
    @State private var username: String
    @State private var password = ""
    @State private var phase = ProbePhase.idle
    @State private var error: String?
    @State private var busy = false

    private enum ProbePhase: Equatable {
        case idle
        case probing
        case enabled
        case disabled
        case unreachable
    }

    init(model: AppModel) {
        self.model = model
        // Seeded here rather than on appear: assigning in `.task` would fire
        // the address field's onChange and reset the probe it starts.
        _origin = State(initialValue: model.accountRecord?.serverOrigin ?? OfficialServer.origin)
        _username = State(initialValue: model.accountRecord?.username ?? "")
    }

    var body: some View {
        Form {
            // Why the reader is signed out, when it wasn't their doing
            // (expired, revoked) or the token outlived the sign-out.
            if model.accountNotice != nil || model.accountSignOutWarning != nil {
                Section {
                    if let notice = model.accountNotice {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    if let warning = model.accountSignOutWarning {
                        Text(warning)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }

            Section {
                TextField("https://…", text: $origin)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.continue)
                    .disabled(phase == .probing || busy)
                    .onSubmit(probe)
                    .onChange(of: origin) { _, _ in
                        if phase != .idle { phase = .idle }
                        error = nil
                    }

                switch phase {
                case .probing:
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking the server…").foregroundStyle(.secondary)
                    }
                case .disabled:
                    Text("This server doesn't have accounts turned on.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                case .unreachable:
                    Text("Can't reach the server. Check the address and your connection.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                case .idle, .enabled:
                    EmptyView()
                }

                if phase != .enabled {
                    Button(phase == .probing ? "Checking…" : "Continue", action: probe)
                        .disabled(origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || phase == .probing
                            || busy)
                }
            } header: {
                Text("Server")
            } footer: {
                Text("To use your own server, change the address. Accounts need https://; for local testing, http://127.0.0.1 also works.")
            }

            if phase == .enabled {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit(login)
                } header: {
                    Text("Sign In")
                } footer: {
                    Text("Once signed in, you can pair the hosts on your account without a QR code.")
                }

                Section {
                    Button {
                        login()
                    } label: {
                        HStack {
                            Spacer()
                            if busy {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Sign in")
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.tactile(.glassProminent))
                    .disabled(busy
                        || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || password.isEmpty)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }

            if let error {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            LegalLinksSection()
        }
        .navigationTitle("Sign In")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(busy)
            }
        }
        .interactiveDismissDisabled(busy)
        .task {
            if phase == .idle { probe() }
        }
    }

    private func probe() {
        let server = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        error = nil
        guard !server.isEmpty else {
            error = AccountCopy.message(AccountFailure(code: "origin_required"))
            return
        }
        guard isSecureServerOrigin(origin: server) else {
            phase = .idle
            error = AccountCopy.message(AccountFailure(code: "insecure_origin"))
            return
        }
        phase = .probing
        let normalized = normalizeServerOrigin(origin: server)
        Task {
            let verdict = await model.probeAccountServer(normalized)
            // A verdict for an address the field no longer holds is stale.
            guard normalizeServerOrigin(origin: origin.trimmingCharacters(in: .whitespacesAndNewlines))
                == normalized else { return }
            switch verdict {
            case .enabled:
                phase = .enabled
            case .disabled:
                phase = .disabled
            case .unreachable:
                phase = .unreachable
            }
        }
    }

    private func login() {
        let server = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !server.isEmpty, !user.isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.accountLogin(
                origin: server, username: user, password: password)
            busy = false
            if let failure {
                error = AccountCopy.message(failure)
            }
        }
    }
}
