//! One sans-I/O WebRTC peer: STUN gathering, an SDP offer/answer exchange,
//! and a reliable ordered DataChannel built by str0m.
//!
//! The platform layer owns every side effect. Each public mutator returns the
//! datagrams to send, the next absolute deadline, and the events the
//! coordinator turns into its own RTC events. str0m's contract — drain
//! `poll_output` until `Timeout` after every mutation — is enforced in
//! `drive`, so no caller has to know it.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::crypto::CryptoProvider;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc, RtcConfig};

use crate::stun::{StunClient, StunReply};

/// Candidate gathering budget, matching the host's 2s non-trickle window.
const GATHER_WINDOW: Duration = Duration::from_secs(2);
/// ICE + DTLS + SCTP budget once the answer is in.
const CONNECT_WINDOW: Duration = Duration::from_secs(10);
/// SCTP send buffer. One Noise record is at most 64 KiB, so a full buffer
/// still leaves the whole record either accepted or cleanly rejected.
const SCTP_BUFFER: usize = 512 * 1024;
/// Tell the coordinator when the send queue has drained far enough for the
/// next record; it does the record-level pacing, not this engine.
const LOW_WATER: usize = 64 * 1024;
// The host rejects any other label (packages/protocol/src/rtc.ts).
const CHANNEL_LABEL: &str = "pinomad";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineConfig {
    /// The address the platform's UDP socket is bound to.
    pub local_addr: SocketAddr,
    /// Resolved STUN servers. Empty means host candidates only.
    pub stun_servers: Vec<SocketAddr>,
}

/// Everything the platform must do or report after one engine call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Send these bytes from the peer's UDP socket.
    Transmit {
        destination: SocketAddr,
        bytes: Vec<u8>,
    },
    /// Arm the peer's single timer for this absolute monotonic millisecond.
    Schedule {
        at_ms: u64,
    },
    /// The offer is ready; send it to the host over the signalling path.
    LocalOffer {
        sdp: String,
    },
    ChannelOpened,
    Data {
        bytes: Vec<u8>,
    },
    /// SCTP is below the low-water mark; the coordinator may send more.
    BufferedAmountLow,
    /// The selected ICE pair changed. Both ends carry the library's candidate
    /// type and the socket address the pair uses.
    SelectedCandidate {
        local: SelectedCandidateEnd,
        remote: SelectedCandidateEnd,
    },
    /// The peer is finished. Emitted at most once per engine.
    Closed {
        reason: String,
    },
}

/// One end of a selected ICE pair, as str0m reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedCandidateEnd {
    pub kind: String,
    pub address: SocketAddr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    /// str0m's `Channel::write` returned true: the record is in SCTP.
    Accepted,
    /// The channel is not open, or its buffer is full. The coordinator keeps
    /// the record and retries it unchanged; this is str0m's "not received".
    Rejected,
}

pub struct Engine {
    base: Instant,
    base_ms: u64,
    rtc: Rtc,
    phase: Phase,
    local_addr: SocketAddr,
    stun_servers: Vec<SocketAddr>,
    local_kind: HashMap<SocketAddr, String>,
    remote_kind: HashMap<SocketAddr, String>,
    stun: Option<StunClient>,
    gather_deadline: Option<Instant>,
    pending_offer: Option<SdpPendingOffer>,
    connect_deadline: Option<Instant>,
    rtc_timeout: Option<Instant>,
    channel: Option<ChannelId>,
    last_pair: Option<(SelectedCandidateEnd, SelectedCandidateEnd)>,
    closed_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    New,
    Gathering,
    Signalling,
    Connecting,
    Active,
    Closed,
}

impl Engine {
    pub fn new(config: EngineConfig, now_ms: u64) -> Self {
        let base = Instant::now();
        let provider: Arc<CryptoProvider> = Arc::new(str0m_rust_crypto::default_provider());
        let mut rtc = RtcConfig::new()
            .set_crypto_provider(provider)
            // PeerStats carries the selected ICE pair; the UI's path label
            // (`P2P (host ↔ host)`) reads it, so ask str0m for it once a
            // second.
            .set_stats_interval(Some(Duration::from_secs(1)))
            .set_sctp_max_buffered_amount(SCTP_BUFFER)
            .build(base);
        let mut local_kind = HashMap::new();
        if let Ok(candidate) = Candidate::host(config.local_addr, "udp") {
            local_kind.insert(config.local_addr, "host".to_string());
            rtc.add_local_candidate(candidate);
        }
        Engine {
            base,
            base_ms: now_ms,
            rtc,
            phase: Phase::New,
            local_addr: config.local_addr,
            stun_servers: config.stun_servers,
            local_kind,
            remote_kind: HashMap::new(),
            stun: None,
            gather_deadline: None,
            pending_offer: None,
            connect_deadline: None,
            rtc_timeout: None,
            channel: None,
            last_pair: None,
            closed_reason: None,
        }
    }

    fn instant(&self, now_ms: u64) -> Instant {
        self.base + Duration::from_millis(now_ms.saturating_sub(self.base_ms))
    }

    fn millis(&self, instant: Instant) -> u64 {
        self.base_ms + instant.saturating_duration_since(self.base).as_millis() as u64
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn start(&mut self, now_ms: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.phase != Phase::New {
            return actions;
        }
        let now = self.instant(now_ms);
        if self.stun_servers.is_empty() {
            self.finish_gathering(now, &mut actions);
            return actions;
        }
        self.phase = Phase::Gathering;
        let deadline = now + GATHER_WINDOW;
        self.gather_deadline = Some(deadline);
        self.stun = Some(StunClient::new(&self.stun_servers, now, deadline));
        self.send_stun(now, &mut actions);
        self.schedule(&mut actions);
        actions
    }

    fn send_stun(&mut self, now: Instant, actions: &mut Vec<Action>) {
        if let Some(stun) = &mut self.stun {
            for (destination, bytes) in stun.outgoing(now) {
                actions.push(Action::Transmit { destination, bytes });
            }
            self.rtc_timeout = stun.next_timeout();
        }
    }

    pub fn accept_answer(&mut self, now_ms: u64, sdp: &str) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.phase != Phase::Signalling {
            self.fail("no offer is pending", &mut actions);
            return actions;
        }
        let now = self.instant(now_ms);
        let answer = match SdpAnswer::from_sdp_string(sdp) {
            Ok(answer) => answer,
            Err(error) => {
                self.fail(
                    &format!("the answer SDP could not be parsed: {error}"),
                    &mut actions,
                );
                return actions;
            }
        };
        self.parse_remote_candidates(sdp);
        let Some(pending) = self.pending_offer.take() else {
            self.fail("the offer was already consumed", &mut actions);
            return actions;
        };
        if let Err(error) = self.rtc.sdp_api().accept_answer(pending, answer) {
            self.fail(&format!("the answer was refused: {error}"), &mut actions);
            return actions;
        }
        self.phase = Phase::Connecting;
        self.connect_deadline = Some(now + CONNECT_WINDOW);
        self.drive(now, &mut actions);
        actions
    }

    pub fn receive(&mut self, now_ms: u64, source: SocketAddr, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.phase == Phase::Closed {
            return actions;
        }
        let now = self.instant(now_ms);
        if self.phase == Phase::Gathering {
            let reply = self.stun.as_mut().and_then(|stun| stun.handle(now, bytes));
            if let Some(reply) = reply {
                self.handle_stun_reply(reply, &mut actions);
                if self.stun.as_ref().is_some_and(|stun| stun.pending() == 0) {
                    self.finish_gathering(now, &mut actions);
                } else {
                    self.schedule(&mut actions);
                }
            }
            return actions;
        }
        if matches!(self.phase, Phase::Signalling) {
            return actions;
        }
        let contents = match TryInto::<str0m::net::DatagramRecv>::try_into(bytes) {
            Ok(contents) => contents,
            Err(_) => return actions,
        };
        let input = Input::Receive(
            now,
            Receive {
                proto: Protocol::Udp,
                source,
                destination: self.local_addr,
                contents,
            },
        );
        if !self.rtc.accepts(&input) {
            return actions;
        }
        if let Err(error) = self.rtc.handle_input(input) {
            self.fail(
                &format!("inbound datagram handling failed: {error}"),
                &mut actions,
            );
            return actions;
        }
        self.drive(now, &mut actions);
        actions
    }

    fn handle_stun_reply(&mut self, reply: StunReply, _actions: &mut [Action]) {
        let base = self.local_addr;
        // A mapped address of the other family cannot be a candidate for this
        // socket: sending to it would use a source the socket never bound.
        if reply.mapped.is_ipv4() != base.is_ipv4() {
            return;
        }
        if self.local_kind.contains_key(&reply.mapped) {
            return;
        }
        match Candidate::server_reflexive(reply.mapped, base, "udp") {
            Ok(candidate) => {
                self.local_kind.insert(reply.mapped, "srflx".to_string());
                self.rtc.add_local_candidate(candidate);
            }
            Err(_) => {}
        }
    }

    fn finish_gathering(&mut self, now: Instant, actions: &mut Vec<Action>) {
        self.stun = None;
        self.gather_deadline = None;
        self.rtc_timeout = None;
        let mut api = self.rtc.sdp_api();
        let channel = ChannelConfig {
            label: CHANNEL_LABEL.to_string(),
            ordered: true,
            reliability: Reliability::Reliable,
            negotiated: None,
            protocol: String::new(),
        };
        api.add_channel_with_config(channel);
        let Some((offer, pending)) = api.apply() else {
            self.fail("str0m produced no offer", actions);
            return;
        };
        self.pending_offer = Some(pending);
        self.phase = Phase::Signalling;
        actions.push(Action::LocalOffer {
            sdp: offer.to_sdp_string(),
        });
        let _ = now;
        self.schedule(actions);
    }

    fn parse_remote_candidates(&mut self, sdp: &str) {
        for line in sdp.lines().filter(|line| line.starts_with("a=candidate:")) {
            let fields: Vec<&str> = line["a=candidate:".len()..].split_whitespace().collect();
            if fields.len() < 8 || fields[6] != "typ" {
                continue;
            }
            let Ok(ip) = fields[4].parse::<IpAddr>() else {
                continue;
            };
            let Ok(port) = fields[5].parse::<u16>() else {
                continue;
            };
            self.remote_kind
                .insert(SocketAddr::new(ip, port), fields[7].to_string());
        }
    }

    pub fn timeout(&mut self, now_ms: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.phase == Phase::Closed {
            return actions;
        }
        let now = self.instant(now_ms);
        if self.phase == Phase::Gathering {
            self.send_stun(now, &mut actions);
            let expired = self.gather_deadline.is_some_and(|deadline| now >= deadline);
            let answered = self.stun.as_ref().is_some_and(|stun| stun.pending() == 0);
            if expired || answered {
                self.finish_gathering(now, &mut actions);
            } else {
                self.schedule(&mut actions);
            }
            return actions;
        }
        if self.phase == Phase::Connecting
            && self.channel.is_none()
            && self
                .connect_deadline
                .is_some_and(|deadline| now >= deadline)
        {
            self.fail(
                "ICE, DTLS, or the DataChannel did not open within 10s",
                &mut actions,
            );
            return actions;
        }
        if let Err(error) = self.rtc.handle_input(Input::Timeout(now)) {
            self.fail(&format!("the timer input failed: {error}"), &mut actions);
            return actions;
        }
        self.drive(now, &mut actions);
        actions
    }

    /// Write one record. `false` from str0m means not accepted; the caller
    /// retries the same ciphertext instead of resealing it.
    pub fn send(&mut self, now_ms: u64, bytes: &[u8]) -> (SendOutcome, Vec<Action>) {
        let mut actions = Vec::new();
        let Some(id) = self.channel else {
            return (SendOutcome::Rejected, actions);
        };
        if self.phase == Phase::Closed {
            return (SendOutcome::Rejected, actions);
        }
        let outcome = {
            let Some(mut channel) = self.rtc.channel(id) else {
                return (SendOutcome::Rejected, actions);
            };
            match channel.write(true, bytes) {
                Ok(true) => SendOutcome::Accepted,
                Ok(false) => SendOutcome::Rejected,
                Err(error) => {
                    self.fail(
                        &format!("the DataChannel write failed: {error}"),
                        &mut actions,
                    );
                    return (SendOutcome::Rejected, actions);
                }
            }
        };
        let now = self.instant(now_ms);
        self.drive(now, &mut actions);
        (outcome, actions)
    }

    /// The coordinator asked to close; no `Closed` action comes back, since
    /// it already knows. Sends after this are rejected.
    pub fn close(&mut self) {
        if self.phase == Phase::Closed {
            return;
        }
        self.phase = Phase::Closed;
        self.closed_reason = Some("closed by the client".to_string());
        self.stun = None;
        self.gather_deadline = None;
        self.connect_deadline = None;
        self.rtc_timeout = None;
        self.pending_offer = None;
        let _ = self.rtc.close();
    }

    pub fn is_closed(&self) -> bool {
        self.phase == Phase::Closed
    }

    fn fail(&mut self, reason: &str, actions: &mut Vec<Action>) {
        if self.phase == Phase::Closed {
            return;
        }
        self.phase = Phase::Closed;
        self.closed_reason = Some(reason.to_string());
        self.stun = None;
        self.gather_deadline = None;
        self.connect_deadline = None;
        self.rtc_timeout = None;
        self.pending_offer = None;
        let _ = self.rtc.close();
        actions.push(Action::Closed {
            reason: reason.to_string(),
        });
    }

    fn drive(&mut self, now: Instant, actions: &mut Vec<Action>) {
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(at)) => {
                    self.rtc_timeout = Some(at);
                    break;
                }
                Ok(Output::Transmit(transmit)) => actions.push(Action::Transmit {
                    destination: transmit.destination,
                    bytes: transmit.contents.to_vec(),
                }),
                Ok(Output::Event(event)) => {
                    if !self.handle_event(event, actions) {
                        break;
                    }
                }
                Err(error) => {
                    self.fail(&format!("polling str0m failed: {error}"), actions);
                    break;
                }
            }
        }
        if self.phase != Phase::Closed {
            self.schedule(actions);
        }
        let _ = now;
    }

    fn handle_event(&mut self, event: Event, actions: &mut Vec<Action>) -> bool {
        match event {
            Event::ChannelOpen(id, _label) => {
                self.channel = Some(id);
                self.connect_deadline = None;
                self.phase = Phase::Active;
                if let Some(mut channel) = self.rtc.channel(id) {
                    channel.set_buffered_amount_low_threshold(LOW_WATER);
                }
                actions.push(Action::ChannelOpened);
                true
            }
            Event::ChannelData(data) => {
                actions.push(Action::Data { bytes: data.data });
                true
            }
            Event::ChannelBufferedAmountLow(_) => {
                actions.push(Action::BufferedAmountLow);
                true
            }
            Event::ChannelClose(_) => {
                self.fail("the DataChannel was closed by the peer", actions);
                false
            }
            Event::PeerStats(stats) => {
                if let Some(pair) = &stats.selected_candidate_pair {
                    self.report_pair(pair, actions);
                }
                true
            }
            Event::Closed => {
                self.fail("str0m reported the peer closed", actions);
                false
            }
            _ => true,
        }
    }

    fn report_pair(&mut self, pair: &str0m::stats::CandidatePairStats, actions: &mut Vec<Action>) {
        let local = pair.local.addr;
        let remote = pair.remote.addr;
        let local_type = self
            .local_kind
            .get(&local)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let remote_type = self
            .remote_kind
            .get(&remote)
            .cloned()
            .unwrap_or_else(|| "prflx".to_string());
        let local = SelectedCandidateEnd {
            kind: local_type,
            address: local,
        };
        let remote = SelectedCandidateEnd {
            kind: remote_type,
            address: remote,
        };
        if self.last_pair.as_ref() == Some(&(local.clone(), remote.clone())) {
            return;
        }
        self.last_pair = Some((local.clone(), remote.clone()));
        actions.push(Action::SelectedCandidate { local, remote });
    }

    fn schedule(&mut self, actions: &mut Vec<Action>) {
        if self.phase == Phase::Closed || self.phase == Phase::Signalling {
            return;
        }
        let mut next = self.rtc_timeout;
        // The connect deadline is ours, not str0m's: str0m can stay silent
        // while ICE retransmits, so without it a stuck pair never reports.
        if self.phase == Phase::Connecting {
            next = min_deadline(next, self.connect_deadline);
        }
        if self.phase == Phase::Gathering {
            next = min_deadline(next, self.gather_deadline);
            next = min_deadline(next, self.rtc_timeout);
        }
        if let Some(at) = next {
            actions.push(Action::Schedule {
                at_ms: self.millis(at),
            });
        }
    }
}

fn min_deadline(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}
