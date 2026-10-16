//! pinomad-core: the client-side protocol core shared by the native apps
//! (ADR-0024). It does no I/O — the platform layer opens sockets and timers,
//! feeds events in, and executes the commands that come out. The TypeScript
//! `packages/protocol` is the reference implementation; generated comparison
//! vectors keep the two in lockstep.

pub mod b64;
pub mod delta;
pub mod frames;
pub mod json;
pub mod noise;
pub mod organization;
pub mod pairing_link;
pub mod relay;
pub mod remote_durable;
pub mod secure_channel;
pub mod transport;
pub mod u16str;
