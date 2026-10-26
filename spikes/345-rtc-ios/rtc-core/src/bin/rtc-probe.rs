//! Host-side walker for the same Engine the iOS app drives. It uses a BSD
//! UDP socket and curl for the throwaway HTTP signalling shim, so the P2P
//! path under test is identical to the device path.

use std::collections::VecDeque;
use std::io::Write;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::process::Command;
use std::time::{Duration, Instant};

use rtc_spike_core::engine::{Engine, SpikeAction, SpikeConfig};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut server = "http://127.0.0.1:8765".to_string();
    let mut bind = "127.0.0.1".to_string();
    let mut stun = "stun.cloudflare.com:3478".to_string();
    let mut seed = 7u64;
    let args: Vec<String> = std::env::args().collect();
    let mut index = 1;
    while index + 1 < args.len() {
        match args[index].as_str() {
            "--server" => server = args[index + 1].clone(),
            "--bind" => bind = args[index + 1].clone(),
            "--stun" => stun = args[index + 1].clone(),
            "--seed" => seed = args[index + 1].parse()?,
            other => return Err(format!("unknown argument {other}").into()),
        }
        index += 2;
    }

    let bind_ip = bind.parse()?;
    let socket = UdpSocket::bind(SocketAddr::new(bind_ip, 0))?;
    socket.set_read_timeout(Some(Duration::from_millis(20)))?;
    let local = socket.local_addr()?;
    println!("PROBE local={local} server={server} stun={stun} seed={seed}");

    let stun_servers = resolve_stun(&stun, local.is_ipv4())?;
    let origin = Instant::now();
    let now = origin.elapsed().as_millis() as u64;
    let mut engine = Engine::new(
        SpikeConfig {
            local_addr: local.to_string(),
            stun_servers,
            seed,
            dedupe_duplicates: true,
        },
        now,
    );
    let mut actions: VecDeque<SpikeAction> = engine.start(now).into();
    let mut next_at = None;
    let mut last = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(70);
    let mut complete = false;
    let mut failed = false;

    while Instant::now() < deadline && !complete && !failed {
        while let Some(action) = actions.pop_front() {
            match action {
                SpikeAction::Transmit { destination, bytes } => {
                    let destination: SocketAddr = destination.parse()?;
                    socket.send_to(&bytes, destination)?;
                }
                SpikeAction::Schedule { at_ms } => next_at = Some(at_ms),
                SpikeAction::LocalOffer { sdp } => {
                    let answer = post_offer(&server, &sdp)?;
                    println!("PROBE answer {} bytes", answer.len());
                    let now_ms = origin.elapsed().as_millis() as u64;
                    actions.extend(engine.accept_answer(now_ms, answer));
                }
                SpikeAction::Log { line } => println!("LOG {line}"),
                SpikeAction::IceState { state } => println!("ICE {state}"),
                SpikeAction::CandidatePair {
                    local,
                    remote,
                    local_type,
                    remote_type,
                } => {
                    println!("PAIR {local}/{local_type} -> {remote}/{remote_type}");
                }
                SpikeAction::ChannelOpen { label } => println!("CHANNEL {label}"),
                SpikeAction::NoiseReady { handshake_hash } => {
                    println!("NOISE_READY {handshake_hash}")
                }
                SpikeAction::BulkSent {
                    records,
                    bytes,
                    write_false,
                    buffered,
                } => {
                    println!(
                        "BULK_SENT records={records} bytes={bytes} write_false={write_false} buffered={buffered}"
                    );
                }
                SpikeAction::BulkReceived {
                    records,
                    bytes,
                    matched,
                } => {
                    println!("BULK_RECEIVED records={records} bytes={bytes} matched={matched}");
                }
                SpikeAction::Completed { summary } => {
                    println!("COMPLETE {summary}");
                    complete = true;
                }
                SpikeAction::Failed { reason } => {
                    println!("FAILED {reason}");
                    failed = true;
                }
                SpikeAction::Closed { reason } => println!("CLOSED {reason}"),
            }
        }
        if complete || failed {
            break;
        }

        let now_ms = origin.elapsed().as_millis() as u64;
        if next_at.is_some_and(|at| at <= now_ms) {
            next_at = None;
            actions.extend(engine.timeout(now_ms));
            continue;
        }

        let mut buffer = [0u8; 4096];
        match socket.recv_from(&mut buffer) {
            Ok((len, source)) => {
                let now_ms = origin.elapsed().as_millis() as u64;
                actions.extend(engine.receive(now_ms, source.to_string(), buffer[..len].to_vec()));
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if last.elapsed() > Duration::from_secs(5) {
                    println!(
                        "PROBE waiting next={next_at:?} summary={}",
                        engine.summary()
                    );
                    last = Instant::now();
                }
            }
            Err(error) => return Err(error.into()),
        }
    }

    let now_ms = origin.elapsed().as_millis() as u64;
    for action in engine.stop(now_ms) {
        if let SpikeAction::Log { line } = action {
            println!("STOP {line}");
        }
    }
    println!("SUMMARY {}", engine.summary());
    if complete {
        Ok(())
    } else {
        Err("probe did not complete".into())
    }
}

fn resolve_stun(server: &str, ipv4: bool) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let addresses: Vec<String> = server
        .to_socket_addrs()?
        .filter(|addr| addr.is_ipv4() == ipv4)
        .map(|addr| addr.to_string())
        .collect();
    if addresses.is_empty() {
        return Err(format!("no STUN address for {} (ipv4={ipv4})", server).into());
    }
    Ok(addresses)
}

fn post_offer(server: &str, offer: &str) -> Result<String, Box<dyn std::error::Error>> {
    let path = std::env::temp_dir().join(format!("rtc-probe-{}.sdp", std::process::id()));
    {
        let mut file = std::fs::File::create(&path)?;
        file.write_all(offer.as_bytes())?;
    }
    let url = format!("{}/offer", server.trim_end_matches('/'));
    let output = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "10",
            "--header",
            "content-type: text/plain",
            "--data-binary",
        ])
        .arg(format!("@{}", path.display()))
        .arg(url)
        .output()?;
    let _ = std::fs::remove_file(&path);
    if !output.status.success() {
        return Err(format!("curl failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}
