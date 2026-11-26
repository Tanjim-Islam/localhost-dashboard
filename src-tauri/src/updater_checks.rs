// Generated once with the Tauri CLI using a disposable key and a plain text file.
// Only the public verifier, signature and harmless signed bytes belong in the fixture.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::test::{mock_builder, mock_context, noop_assets};

const PUBLIC: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUzRkExRTFFOEEzMDU5MDEKUldRQldUQ0tIaDc2NDczQUdEcjViY3RzdUwyTHpGZUs4UkR5c0svWlgyUnZWQnhvVjdyZms2WWQK";
const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRQldUQ0tIaDc2NC9zQWgxbXI4SGhhOFA5QjI1QXo2VDRXWU44M1hidCtOUVNCZzJKMXltNndFRVg3R3djamY5Rkl0TExVU29jNHkzZnYvMW9vcUMvam0rZ3RGWnZYRGdVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NzMxNzQ3CWZpbGU6dGVzdC51cGRhdGUJdmVyc2lvbjo5LjkuOQpDcU95cTFmVi9nN0wxUTNBVzdOVHltVC80aVh5K1F3M2hudndhU2NFTm10VHNiVzN2TllPeWJFVWZPeDFSVEZlTnVWRmZKVTZOMTdCZ1QydVhFN0xEQT09Cg==";
const FILE: &[u8] = b"Localhost Dashboard signed updater test\n";

struct Feed {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    manifest: Arc<Mutex<Value>>,
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl Feed {
    fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let manifest = Arc::new(Mutex::new(Value::Null));
        let bytes = Arc::new(Mutex::new(FILE.to_vec()));
        let stop = Arc::new(AtomicBool::new(false));
        let (m, b, shutdown) = (Arc::clone(&manifest), Arc::clone(&bytes), Arc::clone(&stop));
        let thread = std::thread::spawn(move || {
            for connection in listener.incoming() {
                if shutdown.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = connection.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                let (status, content_type, body) = match request.split_whitespace().nth(1) {
                    Some("/latest.json") => {
                        let manifest = m.lock().unwrap();
                        if manifest.is_null() {
                            ("204 No Content", "application/json", vec![])
                        } else {
                            (
                                "200 OK",
                                "application/json",
                                serde_json::to_vec(&*manifest).unwrap(),
                            )
                        }
                    }
                    Some("/fixture.update") => (
                        "200 OK",
                        "application/octet-stream",
                        b.lock().unwrap().clone(),
                    ),
                    _ => ("404 Not Found", "text/plain", vec![]),
                };
                write!(stream,"HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
            manifest,
            bytes,
        }
    }
    fn publish(&self, version: &str) {
        let platform =
            json!({"signature":SIG,"url":format!("http://{}/fixture.update",self.address)});
        *self.manifest.lock().unwrap() = json!({
            "version":version, "notes":"Signed fixture", "pub_date":"2026-11-27T00:00:00Z",
            "platforms": {"windows-x86_64":platform,"windows-aarch64":platform,"darwin-x86_64":platform,
                "darwin-aarch64":platform,"linux-x86_64":platform,"linux-aarch64":platform}
        });
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wake the blocking listener so it can exit before the test returns.
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[test]
fn native_updater_verifies_download_progress_signature_and_signed_version() {
    let feed = Feed::new();
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert("updater".into(),json!({
        "pubkey": PUBLIC, "requireSignedVersion": true, "dangerousInsecureTransportProtocol":true,
        "endpoints":[format!("http://{}/latest.json", feed.address)]
    }));
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    tauri::async_runtime::block_on(async {
        let handle = app.handle();
        assert!(crate::updater::check(handle, PUBLIC)
            .await
            .unwrap()
            .is_none());
        feed.publish("0.1.0");
        assert!(crate::updater::check(handle, PUBLIC)
            .await
            .unwrap()
            .is_none());
        feed.publish("9.9.9");
        let update = crate::updater::check(handle, PUBLIC)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update.version, "9.9.9");
        assert_eq!(update.body.as_deref(), Some("Signed fixture"));
        let mut events = Vec::new();
        let bytes = crate::updater::download(&update, |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(bytes, FILE);
        assert_eq!(events.first().unwrap()["transferred"], 0);
        assert!(events
            .iter()
            .any(|e| e["percent"] == 100. && e["total"] == FILE.len()));
        assert_eq!(
            events.last().unwrap(),
            &json!({"state":"downloaded","version":"9.9.9"})
        );

        *feed.bytes.lock().unwrap() = b"modified fixture".to_vec();
        let mut invalid = Vec::new();
        assert!(crate::updater::download(&update, |e| invalid.push(e))
            .await
            .is_err());
        assert!(invalid.iter().all(|e| e["state"] != "downloaded"));
        *feed.bytes.lock().unwrap() = FILE.to_vec();
        feed.publish("9.9.10");
        let wrong_version = crate::updater::check(handle, PUBLIC)
            .await
            .unwrap()
            .unwrap();
        let error = crate::updater::download(&wrong_version, |_| {})
            .await
            .unwrap_err();
        assert!(
            error.contains("9.9.10") && error.contains("9.9.9"),
            "{error}"
        );
    });
}
