//! The spike's sans-I/O participant: STUN gathering, str0m offer/answer,
//! the DataChannel, and a real Noise record layer driven over it.
//!
//! Swift owns the descriptor, the clock, and the HTTP signalling shim. Every
//! public method here is synchronous and returns the datagrams/timers the
//! platform layer must act on; there are no callbacks and no threads.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pinomad_core::noise::keypair_from_private;
use pinomad_core::secure_channel::{IkClientHandshake, SecureSession, initiate_handshake};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::crypto::CryptoProvider;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

use crate::frame::bulk_frame;
use crate::stun::{StunClient, StunReply};

const GATHER_WINDOW: Duration = Duration::from_secs(2);
const CONNECT_WINDOW: Duration = Duration::from_secs(10);
const BULK_WINDOW: Duration = Duration::from_secs(30);
const LOW_WATER: usize = 128 * 1024;
const SCTP_BUFFER: usize = 512 * 1024;
const DEVICE_PRIVATE: [u8; 32] = [0x11; 32];
const HOST_PRIVATE: [u8; 32] = [0x22; 32];

#[derive(Clone, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct SpikeConfig {
    /// The one address the Swift socket is bound to, including its ephemeral
    /// port. Additional interface addresses are not used because a BSD socket
    /// bound to a wildcard cannot choose its source per datagram.
    pub local_addr: String,
    pub stun_servers: Vec<String>,
    pub seed: u64,
    /// Experimental: drop an exact repeat of the immediately preceding Noise
    /// ciphertext. A reliable channel must not need this; the spike exposes it
    /// so the workaround can be measured instead of hidden.
    pub dedupe_duplicates: bool,
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum SpikeAction {
    Transmit {
        destination: String,
        bytes: Vec<u8>,
    },
    Schedule {
        at_ms: u64,
    },
    LocalOffer {
        sdp: String,
    },
    Log {
        line: String,
    },
    IceState {
        state: String,
    },
    CandidatePair {
        local: String,
        remote: String,
        local_type: String,
        remote_type: String,
    },
    ChannelOpen {
        label: String,
    },
    NoiseReady {
        handshake_hash: String,
    },
    BulkSent {
        records: u64,
        bytes: u64,
        write_false: u64,
        buffered: u64,
    },
    BulkReceived {
        records: u64,
        bytes: u64,
        matched: bool,
    },
    Completed {
        summary: String,
    },
    Failed {
        reason: String,
    },
    Closed {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    New,
    Gathering,
    Signalling,
    Connecting,
    Noise,
    Bulk,
    Complete,
    Failed,
    Closed,
}

struct Inner {
    base: Instant,
    base_ms: u64,
    rtc: Rtc,
    phase: Phase,
    config: SpikeConfig,
    init_error: Option<String>,
    started: bool,
    destination: SocketAddr,
    local_kind: HashMap<SocketAddr, String>,
    remote_kind: HashMap<SocketAddr, String>,
    stun: Option<StunClient>,
    stun_servers: Vec<SocketAddr>,
    gather_deadline: Option<Instant>,
    pending_offer: Option<SdpPendingOffer>,
    connect_deadline: Option<Instant>,
    bulk_deadline: Option<Instant>,
    rtc_timeout: Option<Instant>,
    channel: Option<ChannelId>,
    channel_label: String,
    low_threshold_set: bool,
    noise: NoiseState,
    outbound: VecDeque<Outbound>,
    write_false: u64,
    last_buffered: usize,
    last_now: Instant,
    last_pair: Option<String>,
    log_lines: Vec<String>,
    stopped: bool,
}

struct Outbound {
    bytes: Vec<u8>,
    bulk: bool,
}

enum NoiseStage {
    Idle,
    Handshaking(Box<IkClientHandshake>),
    Ready(SecureSession),
    Complete,
    Failed,
}

struct NoiseState {
    stage: NoiseStage,
    expected_bulk: Option<String>,
    bulk_records: u64,
    bulk_bytes: u64,
    records_sent: u64,
    records_received: u64,
    deduped: u64,
    handshake_hash: String,
    last_record_first: String,
    last_record_cipher: Vec<u8>,
}

impl Default for NoiseState {
    fn default() -> Self {
        NoiseState {
            stage: NoiseStage::Idle,
            expected_bulk: None,
            bulk_records: 0,
            bulk_bytes: 0,
            records_sent: 0,
            records_received: 0,
            deduped: 0,
            handshake_hash: String::new(),
            last_record_first: String::new(),
            last_record_cipher: Vec::new(),
        }
    }
}

pub struct Engine {
    inner: Inner,
}

impl Engine {
    pub fn new(config: SpikeConfig, now_ms: u64) -> Self {
        let base = Instant::now();
        let mut init_error = None;
        let destination = match config.local_addr.parse::<SocketAddr>() {
            Ok(addr) => addr,
            Err(error) => {
                init_error = Some(format!("bad local address: {error}"));
                "127.0.0.1:9".parse().expect("static address")
            }
        };
        let provider: Arc<CryptoProvider> = Arc::new(str0m_rust_crypto::default_provider());
        let mut rtc = RtcConfig::new()
            .set_crypto_provider(provider)
            .set_stats_interval(Some(Duration::from_secs(1)))
            .set_sctp_max_buffered_amount(SCTP_BUFFER)
            .build(base);
        let mut local_kind = HashMap::new();
        if init_error.is_none() {
            match Candidate::host(destination, "udp") {
                Ok(candidate) => {
                    local_kind.insert(destination, "host".to_string());
                    rtc.add_local_candidate(candidate);
                }
                Err(error) => init_error = Some(format!("bad host candidate: {error}")),
            }
        }
        let mut stun_servers = Vec::new();
        for server in &config.stun_servers {
            match server.parse::<SocketAddr>() {
                Ok(addr) => stun_servers.push(addr),
                Err(error) => {
                    init_error = Some(format!("bad STUN address {server}: {error}"));
                }
            }
        }
        Engine {
            inner: Inner {
                base,
                base_ms: now_ms,
                rtc,
                phase: Phase::New,
                config,
                init_error,
                started: false,
                destination,
                local_kind,
                remote_kind: HashMap::new(),
                stun: None,
                stun_servers,
                gather_deadline: None,
                pending_offer: None,
                connect_deadline: None,
                bulk_deadline: None,
                rtc_timeout: None,
                channel: None,
                channel_label: String::new(),
                low_threshold_set: false,
                noise: NoiseState::default(),
                outbound: VecDeque::new(),
                write_false: 0,
                last_buffered: 0,
                last_now: base,
                last_pair: None,
                log_lines: Vec::new(),
                stopped: false,
            },
        }
    }

    fn instant(&self, now_ms: u64) -> Instant {
        self.inner.base + Duration::from_millis(now_ms.saturating_sub(self.inner.base_ms))
    }

    fn millis(&self, instant: Instant) -> u64 {
        self.inner.base_ms
            + instant
                .saturating_duration_since(self.inner.base)
                .as_millis() as u64
    }

    fn log(&mut self, actions: &mut Vec<SpikeAction>, line: impl Into<String>) {
        let line = line.into();
        self.inner.log_lines.push(line.clone());
        actions.push(SpikeAction::Log { line });
    }

    fn fail(&mut self, actions: &mut Vec<SpikeAction>, reason: impl Into<String>) {
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return;
        }
        let reason = reason.into();
        self.inner.phase = Phase::Failed;
        self.inner.bulk_deadline = None;
        self.inner.connect_deadline = None;
        self.log(actions, format!("FAILED: {reason}"));
        let _ = self.inner.rtc.close();
        actions.push(SpikeAction::Failed { reason });
    }

    pub fn start(&mut self, now_ms: u64) -> Vec<SpikeAction> {
        let mut actions = Vec::new();
        if self.inner.started {
            self.fail(&mut actions, "start called twice");
            return actions;
        }
        self.inner.started = true;
        if let Some(error) = self.inner.init_error.clone() {
            self.fail(&mut actions, error);
            return actions;
        }
        let now = self.instant(now_ms);
        self.inner.last_now = now;
        self.log(
            &mut actions,
            format!(
                "start local={} stun={:?}",
                self.inner.destination, self.inner.stun_servers
            ),
        );
        if self.inner.stun_servers.is_empty() {
            self.finish_gathering(now, &mut actions);
            return actions;
        }
        self.inner.phase = Phase::Gathering;
        let deadline = now + GATHER_WINDOW;
        self.inner.gather_deadline = Some(deadline);
        let stun = StunClient::new(&self.inner.stun_servers, now, deadline);
        self.inner.stun = Some(stun);
        self.send_stun(now, &mut actions);
        self.schedule(Some(deadline), &mut actions);
        actions
    }

    fn send_stun(&mut self, now: Instant, actions: &mut Vec<SpikeAction>) {
        let Some(stun) = &mut self.inner.stun else {
            return;
        };
        for (destination, bytes) in stun.outgoing(now) {
            actions.push(SpikeAction::Transmit {
                destination: destination.to_string(),
                bytes,
            });
        }
        self.inner.rtc_timeout = stun.next_timeout();
    }

    pub fn accept_answer(&mut self, now_ms: u64, sdp: String) -> Vec<SpikeAction> {
        let mut actions = Vec::new();
        let now = self.instant(now_ms);
        self.inner.last_now = now;
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return actions;
        }
        let answer = match SdpAnswer::from_sdp_string(&sdp) {
            Ok(answer) => answer,
            Err(error) => {
                self.fail(&mut actions, format!("answer SDP parse failed: {error}"));
                return actions;
            }
        };
        self.parse_remote_candidates(&sdp);
        let Some(pending) = self.inner.pending_offer.take() else {
            self.fail(&mut actions, "no pending offer");
            return actions;
        };
        if let Err(error) = self.inner.rtc.sdp_api().accept_answer(pending, answer) {
            self.fail(&mut actions, format!("accept_answer failed: {error}"));
            return actions;
        }
        self.log(&mut actions, "answer accepted; ICE checks start");
        self.inner.phase = Phase::Connecting;
        self.inner.connect_deadline = Some(now + CONNECT_WINDOW);
        self.drive(now, &mut actions);
        actions
    }

    pub fn receive(&mut self, now_ms: u64, source: String, bytes: Vec<u8>) -> Vec<SpikeAction> {
        let mut actions = Vec::new();
        let now = self.instant(now_ms);
        self.inner.last_now = now;
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return actions;
        }
        let source = match source.parse::<SocketAddr>() {
            Ok(source) => source,
            Err(error) => {
                self.log(
                    &mut actions,
                    format!("ignoring datagram with bad source {source}: {error}"),
                );
                return actions;
            }
        };
        if self.inner.phase == Phase::Gathering {
            let reply = self
                .inner
                .stun
                .as_mut()
                .and_then(|stun| stun.handle(now, &bytes));
            if let Some(reply) = reply {
                self.handle_stun_reply(now, reply, &mut actions);
                self.schedule(self.inner.gather_deadline, &mut actions);
                return actions;
            }
            runtime_log(
                &mut self.inner.log_lines,
                format!("gathering datagram {} bytes from {source}", bytes.len()),
            );
            return actions;
        }
        let contents = match TryInto::<str0m::net::DatagramRecv>::try_into(&bytes[..]) {
            Ok(contents) => contents,
            Err(error) => {
                self.log(
                    &mut actions,
                    format!("unparseable datagram from {source}: {error}"),
                );
                return actions;
            }
        };
        let receive = Receive {
            proto: Protocol::Udp,
            source,
            destination: self.inner.destination,
            contents,
        };
        let input = Input::Receive(now, receive);
        if !self.inner.rtc.accepts(&input) {
            self.log(&mut actions, format!("Rtc rejected datagram from {source}"));
            return actions;
        }
        if let Err(error) = self.inner.rtc.handle_input(input) {
            self.fail(&mut actions, format!("handle_input failed: {error}"));
            return actions;
        }
        self.drive(now, &mut actions);
        actions
    }

    fn handle_stun_reply(
        &mut self,
        now: Instant,
        reply: StunReply,
        actions: &mut Vec<SpikeAction>,
    ) {
        self.log(
            actions,
            format!(
                "STUN mapped {} via {} rtt={}ms",
                reply.mapped,
                reply.server,
                reply.rtt.as_millis()
            ),
        );
        let base = self.inner.destination;
        if reply.mapped.is_ipv4() != base.is_ipv4() {
            self.log(
                actions,
                format!(
                    "ignoring srflx {} with a different family than base {base}",
                    reply.mapped
                ),
            );
            return;
        }
        if let Some(existing) = self.inner.local_kind.get(&reply.mapped) {
            self.log(
                actions,
                format!(
                    "STUN mapped address equals the existing {existing} candidate {}",
                    reply.mapped
                ),
            );
            return;
        }
        match Candidate::server_reflexive(reply.mapped, base, "udp") {
            Ok(candidate) => {
                self.inner
                    .local_kind
                    .insert(reply.mapped, "srflx".to_string());
                self.inner.rtc.add_local_candidate(candidate);
            }
            Err(error) => self.log(actions, format!("could not add srflx candidate: {error}")),
        }
        let _ = now;
    }

    fn finish_gathering(&mut self, now: Instant, actions: &mut Vec<SpikeAction>) {
        self.inner.stun = None;
        self.inner.gather_deadline = None;
        self.log(
            actions,
            format!(
                "gather complete in {}ms; local candidates={:?}",
                self.millis(now).saturating_sub(self.inner.base_ms),
                self.inner.local_kind
            ),
        );
        let mut api = self.inner.rtc.sdp_api();
        let channel = ChannelConfig {
            label: "pinomad-rtc-spike".to_string(),
            ordered: true,
            reliability: Reliability::Reliable,
            negotiated: None,
            protocol: String::new(),
        };
        let _channel_id = api.add_channel_with_config(channel);
        let Some((offer, pending)) = api.apply() else {
            self.fail(actions, "str0m produced no offer");
            return;
        };
        self.inner.pending_offer = Some(pending);
        self.inner.phase = Phase::Signalling;
        let sdp = offer.to_sdp_string();
        for line in sdp.lines().filter(|line| line.starts_with("a=candidate:")) {
            self.log(actions, format!("offer {line}"));
        }
        self.log(
            actions,
            format!("offer {} bytes with m=application", sdp.len()),
        );
        actions.push(SpikeAction::LocalOffer { sdp });
        self.schedule(None, actions);
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
            self.inner
                .remote_kind
                .insert(SocketAddr::new(ip, port), fields[7].to_string());
        }
        self.inner
            .log_lines
            .push(format!("remote candidates={:?}", self.inner.remote_kind));
    }

    pub fn timeout(&mut self, now_ms: u64) -> Vec<SpikeAction> {
        let mut actions = Vec::new();
        if self.inner.stopped
            || matches!(
                self.inner.phase,
                Phase::Failed | Phase::Closed | Phase::Complete
            )
        {
            return actions;
        }
        let now = self.instant(now_ms);
        self.inner.last_now = now;
        if self.inner.phase == Phase::Gathering {
            self.send_stun(now, &mut actions);
            if self
                .inner
                .gather_deadline
                .is_some_and(|deadline| now >= deadline)
            {
                self.finish_gathering(now, &mut actions);
            } else {
                let deadline = self.inner.gather_deadline;
                self.schedule(deadline, &mut actions);
            }
            return actions;
        }
        if self
            .inner
            .connect_deadline
            .is_some_and(|deadline| now >= deadline)
            && self.inner.channel.is_none()
        {
            self.fail(&mut actions, "ICE/DTLS/DataChannel did not open within 10s");
            return actions;
        }
        if self
            .inner
            .bulk_deadline
            .is_some_and(|deadline| now >= deadline)
            && self.inner.phase != Phase::Complete
        {
            self.fail(
                &mut actions,
                "Noise bulk transfer did not finish within 30s",
            );
            return actions;
        }
        if let Err(error) = self.inner.rtc.handle_input(Input::Timeout(now)) {
            self.fail(&mut actions, format!("timeout input failed: {error}"));
            return actions;
        }
        self.drive(now, &mut actions);
        actions
    }

    pub fn stop(&mut self, now_ms: u64) -> Vec<SpikeAction> {
        let mut actions = Vec::new();
        if self.inner.stopped {
            return actions;
        }
        self.inner.stopped = true;
        self.inner.phase = Phase::Closed;
        self.inner.gather_deadline = None;
        self.inner.connect_deadline = None;
        self.inner.bulk_deadline = None;
        let _ = self.inner.rtc.close();
        self.log(
            &mut actions,
            format!("stopped at {now_ms}; Rtc dropped with the engine"),
        );
        actions.push(SpikeAction::Closed {
            reason: "stop requested".to_string(),
        });
        actions
    }

    pub fn summary(&self) -> String {
        format!(
            "phase={:?} local={} local_kind={:?} remote_kind={:?} records_sent={} records_received={} deduped={} bulk_bytes={} write_false={} pair={:?}",
            self.inner.phase,
            self.inner.destination,
            self.inner.local_kind,
            self.inner.remote_kind,
            self.inner.noise.records_sent,
            self.inner.noise.records_received,
            self.inner.noise.deduped,
            self.inner.noise.bulk_bytes,
            self.inner.write_false,
            self.inner.last_pair,
        )
    }
}

impl Engine {
    fn schedule(&self, extra: Option<Instant>, actions: &mut Vec<SpikeAction>) {
        if matches!(
            self.inner.phase,
            Phase::Complete | Phase::Failed | Phase::Closed | Phase::Signalling
        ) {
            return;
        }
        let mut next = extra;
        for candidate in [
            self.inner.rtc_timeout,
            self.inner.gather_deadline,
            self.inner.connect_deadline,
            self.inner.bulk_deadline,
        ]
        .into_iter()
        .flatten()
        {
            next = Some(match next {
                Some(existing) => existing.min(candidate),
                None => candidate,
            });
        }
        if let Some(at) = next {
            actions.push(SpikeAction::Schedule {
                at_ms: self.millis(at),
            });
        }
    }

    fn drive(&mut self, _now: Instant, actions: &mut Vec<SpikeAction>) {
        let first = self.drain(actions);
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return;
        }
        self.pump(actions);
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return;
        }
        let second = self.drain(actions);
        if matches!(self.inner.phase, Phase::Failed | Phase::Closed) {
            return;
        }
        self.inner.rtc_timeout = match (first, second) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        self.schedule(None, actions);
    }

    fn drain(&mut self, actions: &mut Vec<SpikeAction>) -> Option<Instant> {
        loop {
            let output = self.inner.rtc.poll_output();
            match output {
                Ok(Output::Timeout(at)) => return Some(at),
                Ok(Output::Transmit(transmit)) => {
                    actions.push(SpikeAction::Transmit {
                        destination: transmit.destination.to_string(),
                        bytes: transmit.contents.to_vec(),
                    });
                }
                Ok(Output::Event(event)) => {
                    if !self.handle_event(event, actions) {
                        return None;
                    }
                }
                Err(error) => {
                    self.fail(actions, format!("poll_output failed: {error}"));
                    return None;
                }
            }
        }
    }

    fn handle_event(&mut self, event: Event, actions: &mut Vec<SpikeAction>) -> bool {
        match event {
            Event::Connected => {
                self.log(actions, "DTLS connected");
                true
            }
            Event::IceConnectionStateChange(state) => {
                let name = format!("{state:?}");
                self.log(actions, format!("ICE state {name}"));
                actions.push(SpikeAction::IceState { state: name });
                if matches!(state, IceConnectionState::Disconnected) {
                    self.log(
                        actions,
                        "ICE disconnected; waiting for consent/close or the 10s channel deadline",
                    );
                }
                true
            }
            Event::ChannelOpen(id, label) => {
                self.inner.channel = Some(id);
                self.inner.channel_label = label.clone();
                self.inner.connect_deadline = None;
                self.log(actions, format!("DataChannel open id={id:?} label={label}"));
                actions.push(SpikeAction::ChannelOpen { label });
                if let Err(error) = self.start_noise(actions) {
                    self.fail(actions, error);
                    return false;
                }
                true
            }
            Event::ChannelData(data) => {
                if let Err(error) = self.feed_noise(data.data, actions) {
                    self.fail(actions, error);
                    return false;
                }
                true
            }
            Event::ChannelBufferedAmountLow(_) => {
                self.log(
                    actions,
                    format!("buffered-amount-low, queued={}", self.inner.outbound.len()),
                );
                true
            }
            Event::ChannelClose(_) => {
                self.fail(actions, "DataChannel closed by peer");
                false
            }
            Event::PeerStats(stats) => {
                if let Some(pair) = &stats.selected_candidate_pair {
                    self.report_pair(pair, actions);
                }
                true
            }
            Event::Closed => {
                self.log(actions, "str0m reports the peer closed");
                actions.push(SpikeAction::Closed {
                    reason: "peer closed".to_string(),
                });
                self.inner.phase = Phase::Closed;
                false
            }
            _ => true,
        }
    }

    fn report_pair(
        &mut self,
        pair: &str0m::stats::CandidatePairStats,
        actions: &mut Vec<SpikeAction>,
    ) {
        let local = pair.local.addr.to_string();
        let remote = pair.remote.addr.to_string();
        let local_type = self
            .inner
            .local_kind
            .get(&pair.local.addr)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let remote_type = self
            .inner
            .remote_kind
            .get(&pair.remote.addr)
            .cloned()
            .unwrap_or_else(|| "prflx".to_string());
        let key = format!("{local}/{local_type} -> {remote}/{remote_type}");
        if self.inner.last_pair.as_deref() == Some(key.as_str()) {
            return;
        }
        self.inner.last_pair = Some(key.clone());
        self.log(
            actions,
            format!(
                "selected candidate pair {key} rtt={:?}",
                pair.current_round_trip_time
            ),
        );
        actions.push(SpikeAction::CandidatePair {
            local,
            remote,
            local_type,
            remote_type,
        });
    }

    fn start_noise(&mut self, actions: &mut Vec<SpikeAction>) -> Result<(), String> {
        let device = keypair_from_private(&DEVICE_PRIVATE)
            .map_err(|error| format!("device key: {error}"))?;
        let host =
            keypair_from_private(&HOST_PRIVATE).map_err(|error| format!("host key: {error}"))?;
        self.log(
            actions,
            format!(
                "Noise IK start device_pub={} host_pub={}",
                hex(&device.public_key),
                hex(&host.public_key)
            ),
        );
        let handshake = initiate_handshake(&device, host.public_key, None)
            .map_err(|error| format!("Noise initiate: {error}"))?;
        let message = handshake.message1().to_vec();
        self.inner.noise.stage = NoiseStage::Handshaking(Box::new(handshake));
        self.inner.phase = Phase::Noise;
        self.queue_noise(message, false);
        self.log(
            actions,
            format!(
                "queued Noise message1 ({} bytes)",
                self.inner.outbound.len()
            ),
        );
        Ok(())
    }

    fn queue_noise(&mut self, bytes: Vec<u8>, bulk: bool) {
        self.inner.outbound.push_back(Outbound { bytes, bulk });
    }

    fn feed_noise(&mut self, bytes: Vec<u8>, actions: &mut Vec<SpikeAction>) -> Result<(), String> {
        let stage = std::mem::replace(&mut self.inner.noise.stage, NoiseStage::Failed);
        match stage {
            NoiseStage::Handshaking(handshake) => match handshake.read_message2(&bytes) {
                Ok((hello, session, hash)) => {
                    self.inner.noise.handshake_hash = hex(&hash);
                    self.inner.noise.stage = NoiseStage::Ready(session);
                    self.log(
                        actions,
                        format!(
                            "Noise message2 accepted host_hello_v={} hash={}",
                            hello.version,
                            hex(&hash)
                        ),
                    );
                    actions.push(SpikeAction::NoiseReady {
                        handshake_hash: hex(&hash),
                    });
                    self.begin_bulk(actions)?;
                    Ok(())
                }
                Err(error) => Err(format!("Noise message2 rejected: {error}")),
            },
            NoiseStage::Ready(mut session) => {
                if self.inner.config.dedupe_duplicates
                    && !self.inner.noise.last_record_cipher.is_empty()
                    && self.inner.noise.last_record_cipher == bytes
                {
                    self.inner.noise.stage = NoiseStage::Ready(session);
                    self.inner.noise.deduped += 1;
                    let n = self.inner.noise.deduped;
                    self.log(
                        actions,
                        format!(
                            "duplicate Noise record suppressed (#{n}, {} bytes)",
                            bytes.len()
                        ),
                    );
                    return Ok(());
                }
                let current_first = hex(&bytes[..bytes.len().min(8)]);
                let previous_first = self.inner.noise.last_record_first.clone();
                let opened = session.open(&bytes);
                self.inner.noise.last_record_cipher = bytes.clone();
                self.inner.noise.stage = NoiseStage::Ready(session);
                self.inner.noise.records_received += 1;
                self.inner.noise.last_record_first = current_first.clone();
                let record_number = self.inner.noise.records_received;
                if bytes.len() != 65_535 || record_number <= 3 || record_number.is_multiple_of(8) {
                    self.log(
                        actions,
                        format!(
                            "Noise record #{record_number} bytes={} first={}",
                            bytes.len(),
                            hex(&bytes[..bytes.len().min(8)])
                        ),
                    );
                }
                match opened {
                    Ok(Some(text)) => {
                        let expected = self.inner.noise.expected_bulk.clone().unwrap_or_default();
                        let matched = text == expected;
                        self.log(
                            actions,
                            format!(
                                "Noise frame complete received_bytes={} expected_bytes={} matched={matched}",
                                text.len(),
                                expected.len()
                            ),
                        );
                        actions.push(SpikeAction::BulkReceived {
                            records: self.inner.noise.records_received,
                            bytes: text.len() as u64,
                            matched,
                        });
                        self.inner.phase = Phase::Complete;
                        self.inner.bulk_deadline = None;
                        self.inner.noise.stage = NoiseStage::Complete;
                        if matched {
                            let summary = self.summary();
                            self.log(actions, format!("COMPLETE {summary}"));
                            actions.push(SpikeAction::Completed { summary });
                            Ok(())
                        } else {
                            let mismatch =
                                text.bytes().zip(expected.bytes()).position(|(a, b)| a != b);
                            Err(format!(
                                "byte mismatch at {mismatch:?} (received {}, expected {})",
                                text.len(),
                                expected.len()
                            ))
                        }
                    }
                    Ok(None) => Ok(()),
                    Err(error) => Err(format!(
                        "Noise record rejected at #{} ({} bytes first={current_first} previous={previous_first}): {error}",
                        self.inner.noise.records_received,
                        bytes.len()
                    )),
                }
            }
            NoiseStage::Complete => {
                self.inner.noise.stage = NoiseStage::Complete;
                self.log(
                    actions,
                    format!(
                        "ignored {} bytes of DataChannel data after completion (first={})",
                        bytes.len(),
                        hex(&bytes[..bytes.len().min(8)])
                    ),
                );
                Ok(())
            }
            other => {
                self.inner.noise.stage = other;
                Err("Noise data in an unexpected state".to_string())
            }
        }
    }

    fn begin_bulk(&mut self, actions: &mut Vec<SpikeAction>) -> Result<(), String> {
        let frame = bulk_frame(self.inner.config.seed);
        let records = match &mut self.inner.noise.stage {
            NoiseStage::Ready(session) => session
                .seal(&frame)
                .map_err(|error| format!("Noise seal: {error}"))?,
            _ => return Err("Noise session is not ready".to_string()),
        };
        let record_count = records.len() as u64;
        self.inner.noise.bulk_records = record_count;
        self.inner.noise.bulk_bytes = frame.len() as u64;
        self.inner.noise.expected_bulk = Some(frame);
        self.inner.phase = Phase::Bulk;
        self.inner.bulk_deadline = Some(self.inner.last_now + BULK_WINDOW);
        for record in records {
            self.queue_noise(record, true);
        }
        self.log(
            actions,
            format!(
                "sealed one {} byte business frame into {record_count} records; pumping with {} byte SCTP buffer, {} byte low-water",
                self.inner.noise.bulk_bytes, SCTP_BUFFER, LOW_WATER
            ),
        );
        Ok(())
    }

    fn pump(&mut self, actions: &mut Vec<SpikeAction>) {
        let Some(id) = self.inner.channel else { return };
        let mut accepted = 0usize;
        let mut error = None;
        let mut had_bulk = false;
        {
            let Some(mut channel) = self.inner.rtc.channel(id) else {
                return;
            };
            if !self.inner.low_threshold_set {
                channel.set_buffered_amount_low_threshold(LOW_WATER);
                self.inner.low_threshold_set = true;
            }
            while let Some(outbound) = self.inner.outbound.front() {
                match channel.write(true, &outbound.bytes) {
                    Ok(true) => {
                        had_bulk |= outbound.bulk;
                        if outbound.bulk {
                            self.inner.noise.records_sent += 1;
                        }
                        accepted += 1;
                        self.inner.outbound.pop_front();
                    }
                    Ok(false) => {
                        self.inner.write_false += 1;
                        break;
                    }
                    Err(write_error) => {
                        error = Some(format!("DataChannel write failed: {write_error}"));
                        break;
                    }
                }
            }
            self.inner.last_buffered = channel.buffered_amount();
        }
        if let Some(error) = error {
            self.fail(actions, error);
            return;
        }
        if accepted > 0 {
            self.log(
                actions,
                format!(
                    "pumped {accepted} records, queued={}, buffered={}, write_false={}",
                    self.inner.outbound.len(),
                    self.inner.last_buffered,
                    self.inner.write_false
                ),
            );
        }
        if self.inner.outbound.is_empty() && had_bulk {
            self.log(
                actions,
                "all bulk records accepted by SCTP; awaiting Noise echo",
            );
            actions.push(SpikeAction::BulkSent {
                records: self.inner.noise.records_sent,
                bytes: self.inner.noise.bulk_bytes,
                write_false: self.inner.write_false,
                buffered: self.inner.last_buffered as u64,
            });
        }
    }
}

fn runtime_log(lines: &mut Vec<String>, line: String) {
    if lines.len() < 4000 {
        lines.push(line);
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
