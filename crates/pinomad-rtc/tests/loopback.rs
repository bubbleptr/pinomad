//! A real DataChannel between the engine and a bare str0m answerer, with
//! datagrams handed across in memory and a virtual clock. No sockets, no
//! sleeps: send, backpressure and close semantics are deterministic.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pinomad_rtc::{Action, Engine, EngineConfig, SendOutcome};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::crypto::CryptoProvider;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc, RtcConfig};

const START_MS: u64 = 1_000;

struct Wire {
    a: Engine,
    b: Rtc,
    b_base: Instant,
    a_addr: SocketAddr,
    b_addr: SocketAddr,
    now: u64,
    a_transmits: Vec<Vec<u8>>,
    b_transmits: Vec<Vec<u8>>,
    a_next: Option<u64>,
    b_next: Option<u64>,
    b_channel: Option<ChannelId>,
    a_open: bool,
    b_open: bool,
    a_data: Vec<Vec<u8>>,
    b_data: Vec<Vec<u8>>,
    a_closed: Option<String>,
}

impl Wire {
    fn new() -> Self {
        let a_addr: SocketAddr = "127.0.0.1:40001".parse().unwrap();
        let b_addr: SocketAddr = "127.0.0.1:40002".parse().unwrap();
        let a = Engine::new(
            EngineConfig {
                local_addr: a_addr,
                stun_servers: vec![],
            },
            START_MS,
        );
        let b_base = Instant::now();
        let provider: Arc<CryptoProvider> = Arc::new(str0m_rust_crypto::default_provider());
        let mut b = RtcConfig::new().set_crypto_provider(provider).build(b_base);
        b.add_local_candidate(Candidate::host(b_addr, "udp").unwrap());
        Wire {
            a,
            b,
            b_base,
            a_addr,
            b_addr,
            now: START_MS,
            a_transmits: vec![],
            b_transmits: vec![],
            a_next: None,
            b_next: None,
            b_channel: None,
            a_open: false,
            b_open: false,
            a_data: vec![],
            b_data: vec![],
            a_closed: None,
        }
    }

    fn b_instant(&self) -> Instant {
        self.b_base + Duration::from_millis(self.now - START_MS)
    }

    fn handle_a(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Transmit { bytes, .. } => self.a_transmits.push(bytes),
                Action::Schedule { at_ms } => self.a_next = Some(at_ms),
                Action::ChannelOpened => self.a_open = true,
                Action::Data { bytes } => self.a_data.push(bytes),
                Action::Closed { reason } => self.a_closed = Some(reason),
                Action::BufferedAmountLow | Action::SelectedCandidate { .. } => {}
                Action::LocalOffer { .. } => panic!("unexpected second offer"),
            }
        }
    }

    /// Poll the bare answerer until its next Timeout.
    fn drain_b(&mut self) {
        loop {
            match self.b.poll_output() {
                Ok(Output::Timeout(at)) => {
                    self.b_next = Some(
                        START_MS + at.saturating_duration_since(self.b_base).as_millis() as u64,
                    );
                    return;
                }
                Ok(Output::Transmit(transmit)) => {
                    self.b_transmits.push(transmit.contents.to_vec());
                }
                Ok(Output::Event(event)) => match event {
                    Event::ChannelOpen(id, _) => {
                        self.b_channel = Some(id);
                        self.b_open = true;
                    }
                    Event::ChannelData(data) => self.b_data.push(data.data),
                    _ => {}
                },
                Err(error) => panic!("answerer poll failed: {error}"),
            }
        }
    }

    fn feed_b(&mut self, bytes: &[u8]) {
        let contents: str0m::net::DatagramRecv = bytes.try_into().unwrap();
        let input = Input::Receive(
            self.b_instant(),
            Receive {
                proto: Protocol::Udp,
                source: self.a_addr,
                destination: self.b_addr,
                contents,
            },
        );
        if self.b.accepts(&input) {
            self.b.handle_input(input).unwrap();
        }
    }

    /// Hand every queued datagram across, polling after each round.
    fn deliver(&mut self) {
        for _ in 0..200 {
            let a_out = std::mem::take(&mut self.a_transmits);
            let b_out = std::mem::take(&mut self.b_transmits);
            if a_out.is_empty() && b_out.is_empty() {
                return;
            }
            for bytes in a_out {
                self.feed_b(&bytes);
            }
            self.drain_b();
            for bytes in b_out {
                let actions = self.a.receive(self.now, self.b_addr, &bytes);
                self.handle_a(actions);
            }
            self.drain_b();
        }
        panic!("datagram exchange did not settle");
    }

    fn advance(&mut self) -> bool {
        let next = match (self.a_next, self.b_next) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let Some(next) = next else { return false };
        self.now = next.max(self.now);
        let a_actions = self.a.timeout(self.now);
        self.handle_a(a_actions);
        let at = self.b_instant();
        self.b.handle_input(Input::Timeout(at)).unwrap();
        self.drain_b();
        true
    }

    fn run_until_open(&mut self) {
        let mut offer = None;
        for action in self.a.start(self.now) {
            match action {
                Action::LocalOffer { sdp } => offer = Some(sdp),
                other => self.handle_a(vec![other]),
            }
        }
        let offer = SdpOffer::from_sdp_string(&offer.expect("engine offer")).unwrap();
        let answer = self.b.sdp_api().accept_offer(offer).unwrap();
        let actions = self.a.accept_answer(self.now, &answer.to_sdp_string());
        self.handle_a(actions);
        self.drain_b();
        self.deliver();
        let deadline = self.now + 15_000;
        while !(self.a_open && self.b_open) {
            assert!(self.now < deadline, "channel never opened");
            assert!(self.advance(), "no deadline while the channel was closed");
            self.deliver();
        }
    }

    fn pump(&mut self, rounds: usize) {
        for _ in 0..rounds {
            self.deliver();
            if self.a_open && self.b_open {
                self.advance();
                self.deliver();
            }
        }
    }
}

#[test]
fn engine_opens_a_channel_and_carries_data() {
    let mut wire = Wire::new();
    wire.run_until_open();
    let (outcome, actions) = wire.a.send(wire.now, b"hello");
    assert_eq!(outcome, SendOutcome::Accepted);
    wire.handle_a(actions);
    wire.pump(20);
    assert_eq!(wire.b_data, vec![b"hello".to_vec()]);

    let id = wire.b_channel.unwrap();
    wire.b.channel(id).unwrap().write(true, b"world").unwrap();
    wire.drain_b();
    wire.pump(10);
    assert_eq!(wire.a_data, vec![b"world".to_vec()]);
}

#[test]
fn sends_before_the_channel_opens_are_rejected() {
    let mut wire = Wire::new();
    let (outcome, actions) = wire.a.send(START_MS, b"too early");
    assert_eq!(outcome, SendOutcome::Rejected);
    assert!(actions.is_empty());
}

#[test]
fn a_full_send_buffer_is_rejected_not_queued() {
    let mut wire = Wire::new();
    wire.run_until_open();
    let record = vec![7u8; 64 * 1024];
    let mut rejected = false;
    // Hold the datagrams so SCTP cannot drain; str0m must start refusing
    // instead of silently queueing beyond its budget. The coordinator keeps
    // the record and retries the same ciphertext after the low-water event.
    for _ in 0..32 {
        let (outcome, actions) = wire.a.send(wire.now, &record);
        wire.handle_a(actions);
        if outcome == SendOutcome::Rejected {
            rejected = true;
            break;
        }
    }
    assert!(
        rejected,
        "a 512 KiB SCTP buffer must refuse records past its budget"
    );
}

#[test]
fn close_rejects_further_sends_and_reports_once() {
    let mut wire = Wire::new();
    wire.run_until_open();
    wire.a.close();
    assert_eq!(wire.a.send(wire.now, b"late").0, SendOutcome::Rejected);
    assert!(wire.a.timeout(wire.now).is_empty());
    let (_, actions) = wire.a.send(wire.now, b"late");
    wire.handle_a(actions);
    assert!(wire.a_closed.is_none(), "an explicit close has no callback");
}
