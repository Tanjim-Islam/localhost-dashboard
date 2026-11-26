use super::project::Reference;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Target {
    pub reference: Reference,
    pub url: String,
    pub port: u16,
    pub ipv6: bool,
    pub unknown: bool,
}
pub fn probe(t: &Target) -> (Value, Option<bool>) {
    let begin = Instant::now();
    let budget = Duration::from_secs(3);
    let ip = if t.ipv6 {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let addr = SocketAddr::new(ip, t.port);
    let host = if t.ipv6 { "[::1]" } else { "localhost" };
    let io = || -> std::io::Result<(u16, &'static str)> {
        let mut stream = TcpStream::connect_timeout(&addr, budget)?;
        stream.set_write_timeout(Some(budget))?;
        let request = format!(
            "HEAD / HTTP/1.1\r\nHost: {host}:{}\r\nConnection: close\r\n\r\n",
            t.port
        );
        stream.write_all(request.as_bytes())?;
        let mut header = Vec::new();
        let mut buf = [0u8; 2048];
        while header.len() < 32 * 1024 {
            let time = budget
                .checked_sub(begin.elapsed())
                .filter(|d| !d.is_zero())
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::TimedOut))?;
            stream.set_read_timeout(Some(time))?;
            let bytes = stream.read(&mut buf)?;
            if bytes == 0 {
                break;
            }
            header.extend_from_slice(&buf[..bytes]);
            if header.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if header.len() > 5 && !header.starts_with(b"HTTP/") {
                break;
            }
        }
        let end = header
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or(std::io::ErrorKind::InvalidData)?;
        let text = String::from_utf8_lossy(&header[..end]);
        let mut lines = text.lines();
        let status = lines
            .next()
            .and_then(|s| {
                let mut parts = s.split_ascii_whitespace();
                matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1"))
                    .then(|| parts.next())
                    .flatten()
            })
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|n| (100..600).contains(n))
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
        let websocket = lines.take_while(|s| !s.is_empty()).any(|s| {
            s.split_once(':').is_some_and(|(k, v)| {
                k.eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket")
            })
        });
        Ok((
            status,
            if websocket {
                "websocket"
            } else if status == 426 {
                "upgrade"
            } else {
                "http"
            },
        ))
    };
    let result = io();
    let mut value = json!({"key":t.reference.key,"firstSeen":t.reference.first_seen,"url":t.url,"lastChecked":super::now()});
    let answer = match result {
        Ok((status, endpoint)) => {
            let elapsed = begin.elapsed().as_millis() as u64;
            value["status"] = json!(if elapsed < 500 { "healthy" } else { "slow" });
            value["responseTime"] = json!(elapsed);
            value["httpStatus"] = json!(status);
            value["endpoint"] = json!(endpoint);
            Some(endpoint == "http")
        }
        Err(e) => {
            value["status"] = json!("down");
            let timeout = matches!(
                e.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            );
            value["error"] = json!(if timeout {
                "Timeout"
            } else {
                "Local endpoint did not respond to HTTP."
            });
            (!timeout).then_some(false)
        }
    };
    (value, answer)
}
