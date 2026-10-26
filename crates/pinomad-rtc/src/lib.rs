//! PiNomad's sans-I/O WebRTC transport (ADR-0033 §6).
//!
//! The crate knows STUN gathering and str0m; it never opens a socket, reads a
//! clock, or spawns a task. The platform layer (Swift on iOS) binds UDP,
//! resolves STUN host names, feeds every datagram and deadline back in, sends
//! the resulting datagrams, and turns `Action`s into the coordinator's RTC
//! events. That split is what lets the engine be driven from the same ordered
//! queue as the rest of the client, and tested without network I/O.

pub mod engine;
pub mod stun;

pub use engine::{Action, Engine, EngineConfig, SendOutcome};
