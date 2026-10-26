//! Node-side Noise responder. Node owns the libdatachannel socket; this
//! process owns the real record layer, so the DataChannel carries exactly
//! the records `pinomad-core` produces (no reimplementation in JS).

use std::io::{self, BufReader, BufWriter, Read, Write};

use pinomad_core::noise::keypair_from_private;
use pinomad_core::secure_channel::{SecureSession, encode_host_hello, respond_handshake};
use rtc_spike_core::frame::bulk_frame;

const HOST_PRIVATE: [u8; 32] = [0x22; 32];

fn write_frame(out: &mut BufWriter<io::StdoutLock<'static>>, bytes: &[u8]) -> io::Result<()> {
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(bytes)?;
    out.flush()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let seed: u64 = std::env::var("RTC_SPIKE_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7);
    let expected = bulk_frame(seed);
    let host = keypair_from_private(&HOST_PRIVATE)?;
    let mut handshake = Some(respond_handshake(&host)?);
    let mut session: Option<SecureSession> = None;
    let mut echoed = false;
    let stdin = io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    eprintln!("noise-peer ready host_pub={}", u8_hex(&host.public_key));
    loop {
        let mut size = [0u8; 4];
        match input.read_exact(&mut size) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        }
        let len = u32::from_le_bytes(size) as usize;
        if len > 8 * 1024 * 1024 {
            return Err(format!("frame too large: {len}").into());
        }
        let mut frame = vec![0u8; len];
        input.read_exact(&mut frame)?;
        if let Some(mut responder) = handshake.take() {
            let (hello, remote) = responder.read_message1(&frame)?;
            eprintln!(
                "noise-peer msg1 client_hello={} device_pub={}",
                hello,
                u8_hex(&remote)
            );
            let (message, ready) = responder.write_message2(&encode_host_hello())?;
            session = Some(ready);
            write_frame(&mut output, &message)?;
            eprintln!("noise-peer msg2 {} bytes", message.len());
            continue;
        }
        let Some(active) = session.as_mut() else {
            return Err("record before handshake".into());
        };
        match active.open(&frame)? {
            None => {}
            Some(text) => {
                if !echoed {
                    if text != expected {
                        let at = text.bytes().zip(expected.bytes()).position(|(a, b)| a != b);
                        eprintln!(
                            "noise-peer BULK MISMATCH at {:?} received={} expected={}",
                            at,
                            text.len(),
                            expected.len()
                        );
                        std::process::exit(2);
                    }
                    eprintln!(
                        "noise-peer bulk matched bytes={} records_received={}",
                        text.len(),
                        text.len().div_ceil(65518)
                    );
                    let records = active.seal(&text)?;
                    eprintln!("noise-peer echoing {} records", records.len());
                    for record in records {
                        write_frame(&mut output, &record)?;
                    }
                    echoed = true;
                } else {
                    eprintln!("noise-peer received {text}");
                }
            }
        }
    }
    if echoed {
        eprintln!("noise-peer EOF after echo");
    }
    Ok(())
}

fn u8_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
