//! A small sans-I/O STUN binding client. str0m deliberately leaves address
//! gathering to the platform; the spike keeps the protocol here and lets
//! Swift own the UDP socket and the clock.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

const MAGIC_COOKIE: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_RESPONSE: u16 = 0x0101;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const TRANSACTION_BYTES: usize = 12;
const HEADER_BYTES: usize = 20;
const INITIAL_RTO: Duration = Duration::from_millis(250);
const MAX_RTO: Duration = Duration::from_millis(2000);

#[derive(Debug, Clone)]
pub struct StunReply {
    pub server: SocketAddr,
    pub mapped: SocketAddr,
    pub rtt: Duration,
}

struct Transaction {
    id: [u8; TRANSACTION_BYTES],
    server: SocketAddr,
    request: Vec<u8>,
    next_retransmit: Instant,
    rto: Duration,
    attempts: u8,
    sent_at: Option<Instant>,
    done: bool,
}

impl Transaction {
    fn new(server: SocketAddr, now: Instant, id: [u8; TRANSACTION_BYTES]) -> Self {
        let request = encode_binding_request(&id);
        Transaction {
            id,
            server,
            request,
            next_retransmit: now,
            rto: INITIAL_RTO,
            attempts: 0,
            sent_at: None,
            done: false,
        }
    }
}

pub struct StunClient {
    transactions: Vec<Transaction>,
    deadline: Instant,
}

impl StunClient {
    pub fn new(servers: &[SocketAddr], now: Instant, deadline: Instant) -> Self {
        let mut transactions = Vec::with_capacity(servers.len());
        for (index, server) in servers.iter().enumerate() {
            let mut id = [0u8; TRANSACTION_BYTES];
            if getrandom::fill(&mut id).is_err() {
                // The fallback is only for the absurd case where the OS RNG
                // is unavailable; uniqueness, not secrecy, keeps replies apart.
                let n = now.elapsed().as_nanos() as u64 ^ (index as u64) << 32;
                id[..8].copy_from_slice(&n.to_le_bytes());
            }
            transactions.push(Transaction::new(*server, now, id));
        }
        StunClient {
            transactions,
            deadline,
        }
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    /// Initial transmissions and any retransmissions due at `now`.
    pub fn outgoing(&mut self, now: Instant) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut out = Vec::new();
        for transaction in &mut self.transactions {
            if transaction.done || now >= self.deadline {
                continue;
            }
            if now >= transaction.next_retransmit && transaction.attempts < 5 {
                if transaction.attempts > 0 {
                    transaction.rto = (transaction.rto * 2).min(MAX_RTO);
                }
                transaction.attempts += 1;
                transaction.sent_at = Some(now);
                transaction.next_retransmit = now + transaction.rto;
                out.push((transaction.server, transaction.request.clone()));
            }
        }
        out
    }

    pub fn next_timeout(&self) -> Option<Instant> {
        let mut next = self.deadline;
        for transaction in &self.transactions {
            if transaction.done || transaction.attempts >= 5 {
                continue;
            }
            next = next.min(transaction.next_retransmit);
        }
        Some(next)
    }

    pub fn handle(&mut self, now: Instant, data: &[u8]) -> Option<StunReply> {
        let parsed = parse_response(data)?;
        for transaction in &mut self.transactions {
            if transaction.done || transaction.id != parsed.transaction {
                continue;
            }
            transaction.done = true;
            let rtt = transaction
                .sent_at
                .map(|sent| now.saturating_duration_since(sent))
                .unwrap_or_default();
            return Some(StunReply {
                server: transaction.server,
                mapped: parsed.mapped,
                rtt,
            });
        }
        None
    }

    pub fn servers(&self) -> usize {
        self.transactions.len()
    }

    pub fn pending(&self) -> usize {
        self.transactions.iter().filter(|t| !t.done).count()
    }
}

fn encode_binding_request(transaction: &[u8; TRANSACTION_BYTES]) -> Vec<u8> {
    let mut message = Vec::with_capacity(HEADER_BYTES);
    message.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    message.extend_from_slice(&0u16.to_be_bytes());
    message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    message.extend_from_slice(transaction);
    message
}

struct ParsedResponse {
    transaction: [u8; TRANSACTION_BYTES],
    mapped: SocketAddr,
}

fn parse_response(data: &[u8]) -> Option<ParsedResponse> {
    if data.len() < HEADER_BYTES {
        return None;
    }
    let message_type = u16::from_be_bytes([data[0], data[1]]);
    if message_type != BINDING_RESPONSE {
        return None;
    }
    let length = u16::from_be_bytes([data[2], data[3]]) as usize;
    if !length.is_multiple_of(4) || HEADER_BYTES + length > data.len() {
        return None;
    }
    if u32::from_be_bytes([data[4], data[5], data[6], data[7]]) != MAGIC_COOKIE {
        return None;
    }
    let mut transaction = [0u8; TRANSACTION_BYTES];
    transaction.copy_from_slice(&data[8..20]);

    let mut xor_mapped = None;
    let mut mapped = None;
    let mut offset = HEADER_BYTES;
    let end = HEADER_BYTES + length;
    while offset + 4 <= end {
        let attribute = u16::from_be_bytes([data[offset], data[offset + 1]]);
        let attribute_length = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        offset += 4;
        if offset + attribute_length > end {
            return None;
        }
        let value = &data[offset..offset + attribute_length];
        match attribute {
            ATTR_XOR_MAPPED_ADDRESS => xor_mapped = parse_address(value, Some(&transaction)),
            ATTR_MAPPED_ADDRESS => mapped = parse_address(value, None),
            _ => {}
        }
        offset += (attribute_length + 3) & !3;
    }
    Some(ParsedResponse {
        transaction,
        mapped: xor_mapped.or(mapped)?,
    })
}

fn parse_address(value: &[u8], xor: Option<&[u8; TRANSACTION_BYTES]>) -> Option<SocketAddr> {
    if value.len() < 4 {
        return None;
    }
    let family = value[1];
    let mut port = u16::from_be_bytes([value[2], value[3]]);
    if xor.is_some() {
        port ^= (MAGIC_COOKIE >> 16) as u16;
    }
    match family {
        0x01 if value.len() >= 8 => {
            let mut address = [0u8; 4];
            address.copy_from_slice(&value[4..8]);
            if xor.is_some() {
                let cookie = MAGIC_COOKIE.to_be_bytes();
                for i in 0..4 {
                    address[i] ^= cookie[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(address)), port))
        }
        0x02 if value.len() >= 20 => {
            let mut address = [0u8; 16];
            address.copy_from_slice(&value[4..20]);
            if let Some(transaction) = xor {
                let cookie = MAGIC_COOKIE.to_be_bytes();
                for i in 0..4 {
                    address[i] ^= cookie[i];
                }
                for i in 0..12 {
                    address[4 + i] ^= transaction[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(address)), port))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    fn response_for(request: &[u8], mapped: SocketAddr, xor: bool) -> Vec<u8> {
        let transaction: [u8; 12] = request[8..20].try_into().unwrap();
        let mut value = Vec::new();
        let (family, mut address) = match mapped.ip() {
            IpAddr::V4(v4) => (1u8, v4.octets().to_vec()),
            IpAddr::V6(v6) => (2u8, v6.octets().to_vec()),
        };
        let mut port = mapped.port();
        if xor {
            port ^= (MAGIC_COOKIE >> 16) as u16;
            let cookie = MAGIC_COOKIE.to_be_bytes();
            for i in 0..4 {
                address[i] ^= cookie[i];
            }
            if family == 2 {
                for i in 0..12 {
                    address[4 + i] ^= transaction[i];
                }
            }
        }
        value.push(0);
        value.push(family);
        value.extend_from_slice(&port.to_be_bytes());
        value.extend_from_slice(&address);
        let mut attribute = Vec::new();
        let attribute_type = if xor {
            ATTR_XOR_MAPPED_ADDRESS
        } else {
            ATTR_MAPPED_ADDRESS
        };
        attribute.extend_from_slice(&attribute_type.to_be_bytes());
        attribute.extend_from_slice(&(value.len() as u16).to_be_bytes());
        attribute.extend_from_slice(&value);
        let mut message = Vec::new();
        message.extend_from_slice(&BINDING_RESPONSE.to_be_bytes());
        message.extend_from_slice(&(attribute.len() as u16).to_be_bytes());
        message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        message.extend_from_slice(&transaction);
        message.extend_from_slice(&attribute);
        message
    }

    fn client() -> (StunClient, Instant, SocketAddr) {
        let now = Instant::now();
        let server: SocketAddr = "203.0.113.10:3478".parse().unwrap();
        (
            StunClient::new(&[server], now, now + Duration::from_secs(2)),
            now,
            server,
        )
    }

    #[test]
    fn request_has_the_binding_header() {
        let (mut client, now, _) = client();
        let outgoing = client.outgoing(now);
        assert_eq!(outgoing.len(), 1);
        let request = &outgoing[0].1;
        assert_eq!(request.len(), 20);
        assert_eq!(&request[..2], &[0, 1]);
        assert_eq!(&request[4..8], &MAGIC_COOKIE.to_be_bytes());
    }

    #[test]
    fn parses_xor_mapped_ipv4() {
        let (mut client, now, _) = client();
        let request = client.outgoing(now).remove(0).1;
        let mapped: SocketAddr = "198.51.100.23:54321".parse().unwrap();
        let reply = client
            .handle(now, &response_for(&request, mapped, true))
            .unwrap();
        assert_eq!(reply.mapped, mapped);
    }

    #[test]
    fn parses_xor_mapped_ipv6() {
        let (mut client, now, _) = client();
        let request = client.outgoing(now).remove(0).1;
        let mapped = SocketAddr::new(
            IpAddr::V6(Ipv6Addr::new(0x240e, 0x3af, 0x8b1, 0, 0, 0, 0, 1)),
            60000,
        );
        let reply = client
            .handle(now, &response_for(&request, mapped, true))
            .unwrap();
        assert_eq!(reply.mapped, mapped);
    }

    #[test]
    fn ignores_a_response_with_the_wrong_transaction() {
        let (mut client, now, _) = client();
        let request = client.outgoing(now).remove(0).1;
        let mapped: SocketAddr = "198.51.100.23:54321".parse().unwrap();
        let mut reply = response_for(&request, mapped, true);
        reply[8] ^= 0xff;
        assert!(client.handle(now, &reply).is_none());
    }

    #[test]
    fn retransmits_with_backoff_until_deadline() {
        let (mut client, now, _) = client();
        assert_eq!(client.outgoing(now).len(), 1);
        assert!(client.outgoing(now + Duration::from_millis(100)).is_empty());
        assert_eq!(client.outgoing(now + Duration::from_millis(300)).len(), 1);
        assert_eq!(client.outgoing(now + Duration::from_millis(800)).len(), 1);
        assert!(client.outgoing(now + Duration::from_secs(3)).is_empty());
    }
}
