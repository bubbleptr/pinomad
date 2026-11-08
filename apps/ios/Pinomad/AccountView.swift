import PinomadCore
import SwiftUI

/// The account (ADR-0022) as a sheet, for the pages that have no Settings
/// to push it from. Signed out, this is the sign-in form; signed in, the
/// same Account page Settings opens, with its pages above it. One sheet
/// either way, so signing in lands on the account instead of closing.
struct AccountView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var path: [Route] = []
    @State private var removingHost: PendingAccountHost?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.accountSession != nil {
                    if model.accountNeedsEmail {
                        AddEmailView(model: model)
                    } else {
                        AccountPage(model: model)
                    }
                } else {
                    AccountLoginView(model: model)
                }
            }
            .navigationDestination(for: Route.self) { route in
                RouteDestination(model: model, route: route)
            }
            .toolbar {
                if model.accountSession != nil, !model.accountNeedsEmail {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .sheet(item: $removingHost) { host in
                FormSheet {
                    RemoveHostView(
                        model: model, host: host,
                        server: model.accountSession.map { hostOf($0.serverOrigin) } ?? "the server")
                }
            }
        }
        // A fresh stack when the session starts or ends: a sign-up step
        // pushed over the form must not outlive the form.
        .id(model.accountSession == nil)
        // Over the sign-in form and whatever replaces it: "I already have an
        // account" signs in on the way and must stay up until it links.
        .sheet(item: Binding(
            get: { model.accountApplePending },
            set: { model.accountApplePending = $0 }
        )) { pending in
            AppleNoAccountView(model: model, pending: pending)
        }
        // Hosts → a host → Providers lives on this stack too: a saved login or
        // endpoint pops this path, not the root's.
        .environment(\.popToProviders, PopToProvidersAction(stack: "account") { path.popToProviders() })
        // This stack isn't navPath; the focus must follow it all the same.
        .onChange(of: path) { _, path in model.followVisiblePage(path.last) }
        .task {
            // The new-host notice's Remove, from outside this sheet.
            if let host = model.pendingHostRemoval {
                model.pendingHostRemoval = nil
                removingHost = host
            }
            #if DEBUG
            let page = model.devAccountPage
            model.devAccountPage = nil
            if page == "remove-host" {
                removingHost = model.accountRows.first?.pending
            }
            #endif
        }
        .onDisappear {
            // Closing the sheet cancels a pairing ask that is still
            // waiting; a late offer must not replace the session the
            // reader went back to.
            model.invalidateAccountPairing()
            model.followVisiblePage(model.navPath.last)
        }
        // The root shows it while no sheet is up; here while this one is.
        .alert("New Host Joined", isPresented: Binding(
            get: { model.newHostNotice != nil },
            set: { if !$0 { model.dismissNewHostNotice() } }
        )) {
            Button("OK", role: .cancel) { model.dismissNewHostNotice() }
            if model.newHostNotices.count == 1, let host = model.newHostNotices.first {
                Button("Remove from Account", role: .destructive) {
                    model.dismissNewHostNotice()
                    removingHost = host
                }
            } else if model.accountSession != nil {
                Button("Review Hosts") {
                    model.dismissNewHostNotice()
                    path.append(.hosts)
                }
            }
        } message: {
            Text((model.newHostNotice ?? "") + "\n\n" + HostLinkCopy.newHostsHint)
        }
    }
}
