// The piece of packages/protocol/src/transcript.ts the apps need for the
// derivation layer: whether the conversation has a run in flight.

use crate::json::Json;

/// `isBusy(view)` — `pi.live.run` is present exactly while a run is in flight.
/// An absent `pi.live` doc — or one that is not an object — reads as idle.
pub fn is_busy(view: &Json) -> bool {
    view.get("docs")
        .and_then(|docs| docs.get("pi.live"))
        .and_then(|live| live.get("run"))
        .is_some()
}
