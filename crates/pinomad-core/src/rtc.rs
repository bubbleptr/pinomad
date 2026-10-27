// Shared RTC diagnostics shapes (issue #385): the platform reports a raw
// candidate pair, the coordinator classifies it against the same address
// rules as the TypeScript reference, and diagnostics carry the result.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RtcAddressScope {
    Loopback,
    Lan,
    Tailnet,
    Public,
    Unknown,
}

impl RtcAddressScope {
    pub fn as_str(self) -> &'static str {
        match self {
            RtcAddressScope::Loopback => "loopback",
            RtcAddressScope::Lan => "lan",
            RtcAddressScope::Tailnet => "tailnet",
            RtcAddressScope::Public => "public",
            RtcAddressScope::Unknown => "unknown",
        }
    }
}

/// One end as the platform reports it: no scope, no interpretation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RtcCandidateInfo {
    pub rtc_type: Option<String>,
    pub address: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RtcCandidateEnd {
    pub rtc_type: Option<String>,
    pub address: Option<String>,
    pub scope: RtcAddressScope,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RtcSelectedPair {
    pub local: RtcCandidateEnd,
    pub remote: RtcCandidateEnd,
}

impl RtcCandidateEnd {
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        if let Some(rtc_type) = &self.rtc_type {
            object.set(U16String::from_str("type"), Json::from(rtc_type.clone()));
        }
        if let Some(address) = &self.address {
            object.set(U16String::from_str("address"), Json::from(address.clone()));
        }
        object.set(
            U16String::from_str("scope"),
            Json::from(self.scope.as_str()),
        );
        Json::Object(Arc::new(object))
    }
}

impl RtcSelectedPair {
    pub fn to_json(&self) -> Json {
        let mut object = JsonObject::new();
        object.set(U16String::from_str("local"), self.local.to_json());
        object.set(U16String::from_str("remote"), self.remote.to_json());
        Json::Object(Arc::new(object))
    }
}

pub fn rtc_candidate_end(info: &RtcCandidateInfo) -> RtcCandidateEnd {
    RtcCandidateEnd {
        rtc_type: info.rtc_type.clone(),
        address: info.address.clone(),
        scope: rtc_address_scope(info.address.as_deref()),
    }
}

pub fn rtc_selected_pair(local: &RtcCandidateInfo, remote: &RtcCandidateInfo) -> RtcSelectedPair {
    RtcSelectedPair {
        local: rtc_candidate_end(local),
        remote: rtc_candidate_end(remote),
    }
}

pub fn rtc_address_scope(address: Option<&str>) -> RtcAddressScope {
    let Some(ip) = address.and_then(parse_address) else {
        return RtcAddressScope::Unknown;
    };
    match ip {
        IpAddr::V4(ipv4) => ipv4_scope(ipv4),
        IpAddr::V6(ipv6) => match ipv6.to_ipv4_mapped() {
            Some(ipv4) => ipv4_scope(ipv4),
            None => ipv6_scope(ipv6),
        },
    }
}

/// Accept what the platform may carry: a bare IP, an IP:port pair, a
/// bracketed IPv6 address, and an IPv6 zone id. Anything else is unknown.
fn parse_address(address: &str) -> Option<IpAddr> {
    let text = address.trim();
    if text.is_empty() {
        return None;
    }
    let host = if let Some(rest) = text.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        if !tail.is_empty() {
            let port = tail.strip_prefix(':')?;
            if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
        }
        host
    } else if text.matches(':').count() == 1 {
        let (host, port) = text.split_once(':')?;
        if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            host
        } else {
            text
        }
    } else {
        text
    };
    let host = host.split('%').next().unwrap_or(host);
    host.parse::<IpAddr>().ok()
}

fn ipv4_scope(ip: Ipv4Addr) -> RtcAddressScope {
    let [a, b, _, _] = ip.octets();
    if a == 127 {
        RtcAddressScope::Loopback
    } else if a == 100 && (64..=127).contains(&b) {
        RtcAddressScope::Tailnet
    } else if a == 10
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
    {
        RtcAddressScope::Lan
    } else {
        RtcAddressScope::Public
    }
}

fn ipv6_scope(ip: Ipv6Addr) -> RtcAddressScope {
    let segments = ip.segments();
    if segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0 {
        return RtcAddressScope::Tailnet;
    }
    if segments[0] & 0xfe00 == 0xfc00 || segments[0] & 0xffc0 == 0xfe80 {
        return RtcAddressScope::Lan;
    }
    if ip == Ipv6Addr::LOCALHOST {
        return RtcAddressScope::Loopback;
    }
    RtcAddressScope::Public
}

