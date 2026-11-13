import Testing
@testable import PinomadCore

/// Mirrors `accountErrorField` in apps/web/src/widgets/account/account-error.ts.
@Suite struct AccountErrorFieldTests {
    private func failure(_ code: String) -> AccountFailure { AccountFailure(code: code) }

    @Test func codesTheReaderFixesInOneInputNameIt() {
        #expect(AccountCopy.field(failure("origin_required")) == .server)
        #expect(AccountCopy.field(failure("insecure_origin")) == .server)
        #expect(AccountCopy.field(failure("invalid_email")) == .email)
        #expect(AccountCopy.field(failure("email_taken")) == .email)
        #expect(AccountCopy.field(failure("invalid_credentials")) == .password)
        #expect(AccountCopy.field(failure("wrong_password")) == .password)
        #expect(AccountCopy.field(failure("weak_password")) == .newPassword)
        #expect(AccountCopy.field(failure("password_required")) == .newPassword)
        #expect(AccountCopy.field(failure("invalid_code")) == .code)
    }

    @Test func formWideCodesHaveNoField() {
        for code in ["rate_limited", "network", "invalid_reauth", "host_offline", "last_method"] {
            #expect(AccountCopy.field(failure(code)) == nil)
        }
    }

    @Test func theFormShowsWhatNoFieldOnScreenTakes() {
        let weak = failure("weak_password")
        #expect(AccountCopy.fieldMessage(weak, .newPassword) == AccountCopy.message(weak))
        #expect(AccountCopy.formMessage(weak, fields: [.newPassword]) == nil)
        // No new-password field on this form: the form says it.
        #expect(AccountCopy.formMessage(weak, fields: [.email]) == AccountCopy.message(weak))
        #expect(AccountCopy.fieldMessage(failure("rate_limited"), .email) == nil)
        #expect(AccountCopy.formMessage(nil, fields: []) == nil)
    }
}

/// A refused password or code goes on the confirmation's field only when
/// that field was asked this time; otherwise it is the action's own.
@MainActor
@Suite struct IdentityClaimTests {
    @Test func aPasswordStepClaimsAWrongPassword() {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        #expect(step.claim(AccountFailure(code: "wrong_password"), duringConfirm: false))
        #expect(step.fieldError == AccountFailure(code: "wrong_password"))
    }

    @Test func aPasswordStepLeavesAWeakNewPasswordToItsField() {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        #expect(!step.claim(AccountFailure(code: "weak_password"), duringConfirm: false))
        #expect(step.fieldError == nil)
    }

    @Test func aCodeStepClaimsOnlyWhatItsOwnTradeRefused() {
        let step = IdentityConfirmation()
        step.load(hasPassword: false)
        // The action's own code (a new email's) came back wrong: not ours.
        #expect(!step.claim(AccountFailure(code: "invalid_code"), duringConfirm: false))
        #expect(step.claim(AccountFailure(code: "invalid_code"), duringConfirm: true))
        #expect(step.fieldError?.code == "invalid_code")
    }

    /// An expired confirmation is asked again, not blamed on a field.
    @Test func anExpiredConfirmationIsNeverAFieldError() {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        #expect(!step.claim(AccountFailure(code: "invalid_reauth"), duringConfirm: false))
        #expect(step.fieldError == nil)
    }

    @Test func editingOrANewTryClearsTheFieldError() {
        let step = IdentityConfirmation()
        step.load(hasPassword: true)
        step.claim(AccountFailure(code: "wrong_password"), duringConfirm: false)
        step.clearFieldError()
        #expect(step.fieldError == nil)
    }
}
