import PinomadCore
import SwiftUI

/// Sign in to the one account (ADR-0022): address first, probe, then the
/// credentials. The probe is the only thing that leaves the device before a
/// login, and an insecure address never leaves it at all.
struct AccountLoginView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var origin = ""
    @State private var username = ""
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

    var body: some View {
        NavigationStack {
            Form {
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
                            Text("正在检查服务端…").foregroundStyle(.secondary)
                        }
                    case .disabled:
                        Text("这个服务端没有开启账号。")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    case .unreachable:
                        Text("连不上服务端，检查地址和网络。")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    case .idle, .enabled:
                        EmptyView()
                    }

                    if phase != .enabled {
                        Button(phase == .probing ? "正在检查…" : "继续", action: probe)
                            .disabled(origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || phase == .probing
                                || busy)
                    }
                } header: {
                    Text("服务端")
                } footer: {
                    Text("账号只走 https://；本机调试可以用 http://127.0.0.1。")
                }

                if phase == .enabled {
                    Section {
                        TextField("用户名", text: $username)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                        SecureField("密码", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .onSubmit(login)
                    } header: {
                        Text("登录")
                    } footer: {
                        Text("登录后可以不用扫码，直接配对你账号下的宿主。")
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
                                    Text("登录")
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.borderedProminent)
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
            }
            .navigationTitle("登录账号")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(busy)
                }
            }
            .interactiveDismissDisabled(busy)
            .task {
                if origin.isEmpty { origin = model.accountRecord?.serverOrigin ?? "" }
                if username.isEmpty { username = model.accountRecord?.username ?? "" }
            }
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
            } else {
                dismiss()
            }
        }
    }
}
