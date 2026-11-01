/// What an iPhone with no stored host opens on (#493). Signed in to an
/// account with no hosts at all, it is the add-your-first-host home; every
/// other case keeps the connect page (QR code, pairing link, the sign-in
/// entry or the account's hosts to pair). Hosts that exist but are offline,
/// unpaired or changed their key stay there, where they can be paired.
public struct NoHostHome: Equatable, Sendable {
    public enum Screen: Equatable, Sendable {
        case connect
        /// `refreshError` is the last refresh's failure: the list it kept
        /// is still empty, so the home stays and says it couldn't check.
        case firstHost(refreshError: String?)
    }

    /// How often the page asks for the account's hosts. The app otherwise
    /// asks only at sign-in and on a return to the foreground, and a join
    /// command running on a computer brings neither.
    public static let refreshInterval: Duration = .seconds(10)

    public let screen: Screen
    /// Signed in, the page keeps refreshing on either screen, not only on
    /// the first-host home: a host that joined offline is listed (the
    /// connect page replaces the home) and the round after it comes online
    /// pairs it. It stops when a stored host takes the app off this page.
    public let refreshesAccountHosts: Bool

    /// `accountHosts` is nil until this session's first answer: an account
    /// that may have hosts doesn't get a join command minted for it.
    public init(signedIn: Bool, accountHosts: [AccountHostRow]?, hostsError: String?) {
        refreshesAccountHosts = signedIn
        if signedIn, let accountHosts, accountHosts.isEmpty {
            screen = .firstHost(refreshError: hostsError)
        } else {
            screen = .connect
        }
    }
}
