//! UniFFI facade: one object, one mutex, synchronous calls and actions.
//! Swift already serialises every input onto one queue, so this lock is only
//! the FFI boundary's ownership mechanism, not a second scheduler.

use std::sync::{Arc, Mutex};

use crate::engine::{Engine, SpikeAction, SpikeConfig};

#[derive(uniffi::Object)]
pub struct SpikePeer {
    inner: Mutex<Engine>,
}

#[uniffi::export]
impl SpikePeer {
    #[uniffi::constructor]
    pub fn new(config: SpikeConfig, now_ms: u64) -> Arc<Self> {
        Arc::new(SpikePeer {
            inner: Mutex::new(Engine::new(config, now_ms)),
        })
    }

    pub fn start(&self, now_ms: u64) -> Vec<SpikeAction> {
        self.inner
            .lock()
            .expect("spike engine poisoned")
            .start(now_ms)
    }

    pub fn accept_answer(&self, now_ms: u64, sdp: String) -> Vec<SpikeAction> {
        self.inner
            .lock()
            .expect("spike engine poisoned")
            .accept_answer(now_ms, sdp)
    }

    pub fn receive(&self, now_ms: u64, source: String, bytes: Vec<u8>) -> Vec<SpikeAction> {
        self.inner
            .lock()
            .expect("spike engine poisoned")
            .receive(now_ms, source, bytes)
    }

    pub fn timeout(&self, now_ms: u64) -> Vec<SpikeAction> {
        self.inner
            .lock()
            .expect("spike engine poisoned")
            .timeout(now_ms)
    }

    pub fn stop(&self, now_ms: u64) -> Vec<SpikeAction> {
        self.inner
            .lock()
            .expect("spike engine poisoned")
            .stop(now_ms)
    }

    pub fn summary(&self) -> String {
        self.inner.lock().expect("spike engine poisoned").summary()
    }
}
