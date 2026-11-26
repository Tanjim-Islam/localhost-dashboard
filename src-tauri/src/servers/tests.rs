use super::*;
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
};
use tempfile::tempdir;

#[test]
fn project_identity_preserves_existing_hashes_and_conflicting_roots_are_unassigned() {
    // Known SHA-256 prefix used by the original TypeScript implementation.
    assert_eq!(project::hash("abc"), "ba7816bf8f01cfea414140de5dae2223");
    let dir = tempdir().unwrap();
    let root = dir.path().join("workspace");
    let package = root.join("packages").join("server");
    let other = dir.path().join("other");
    for d in [&root, &package, &other] {
        fs::create_dir_all(d).unwrap()
    }
    fs::write(
        root.join("package.json"),
        r#"{"name":"Workspace","workspaces":["packages/*"]}"#,
    )
    .unwrap();
    fs::write(package.join("package.json"), r#"{"name":"API"}"#).unwrap();
    fs::write(other.join("go.mod"), "module other").unwrap();
    let e = project::identify(&package, &[]).unwrap();
    assert_eq!(e.name, "Workspace");
    assert_eq!(e.service_name.as_deref(), Some("API"));
    assert!(project::identify(
        &package,
        &["node".into(), other.join("a.js").into_os_string()]
    )
    .is_none());
    let argv = |p: &str| vec!["node".into(), "app.js".into(), "--port".into(), p.into()];
    assert_eq!(
        project::association(&root, Path::new("node"), &argv("42")),
        project::association(&root, Path::new("node"), &argv("84"))
    );
    fs::create_dir(package.join(".git")).unwrap();
    assert_eq!(project::identify(&package, &[]).unwrap().name, "API");
}
#[test]
fn migration_preserves_project_notes_and_legacy_source() {
    let dir = tempdir().unwrap();
    let projects = json!({"state":{"schemaVersion":1,"projects":[{"id":"p","directory":"old","name":"Old","notes":"saved","pinned":true}]}});
    crate::storage::write_json(dir.path(), "projects.json", &projects).unwrap();
    crate::storage::write_json(
        dir.path(),
        "port-notes.json",
        &json!({"notes":{"4242":"legacy"}}),
    )
    .unwrap();
    let servers = Servers::new(dir.path()).unwrap();
    let mut c = servers.core.lock().unwrap();
    assert_eq!(c.model.projects[0].notes, "saved");
    assert!(!c.model.projects[0].ignored);
    assert_eq!(c.model.legacy_notes[0].text, "legacy");
    save(dir.path(), &mut c).unwrap();
    assert_eq!(Model::load(dir.path()).unwrap().legacy_notes.len(), 1);
    assert_eq!(
        crate::storage::read_json(dir.path(), "port-notes.json", Value::Null).unwrap()["notes"]
            ["4242"],
        "legacy"
    );
}
#[test]
fn health_checks_both_address_families_and_ignores_response_bodies() {
    for (host, ipv6, reply, kind) in [
        ("127.0.0.1", false, "200 OK", "http"),
        ("::1", true, "426 Upgrade Required", "upgrade"),
    ] {
        let socket = TcpListener::bind((host, 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut conn, _) = socket.accept().unwrap();
            let mut reader = BufReader::new(&conn);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("HEAD / "));
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            write!(
                conn,
                "HTTP/1.1 {reply}\r\nContent-Length: 17\r\n\r\nprivate-test-body"
            )
            .unwrap();
        });
        let target = health::Target {
            reference: Reference {
                key: format!("1:{port}"),
                first_seen: 9,
            },
            url: format!("http://{host}:{port}"),
            port,
            ipv6,
            unknown: false,
        };
        let (result, _) = health::probe(&target);
        worker.join().unwrap();
        assert_eq!(result["endpoint"], kind);
        assert_eq!(result["firstSeen"], 9);
        assert_eq!(
            result["status"],
            if result["responseTime"].as_u64().unwrap() < 500 {
                "healthy"
            } else {
                "slow"
            }
        );
        assert!(!result.to_string().contains("private-test-body"));
    }
}
#[test]
fn npm_literal_arguments_reject_expansions() {
    assert_eq!(
        npm::words(r#" a 'two words' "" c\ d"#).unwrap(),
        ["a", "two words", "", "c d"]
    );
    for bad in ["a; curl", "$HOME", "hello *", "unterminated '", "$(echo x)"] {
        assert!(npm::words(bad).is_none())
    }
}
#[test]
fn mac_npm_recovers_observed_shell_suffix() {
    use std::collections::BTreeMap;
    let id = |pid, exe: &str| Identity {
        pid,
        started: 123,
        unix_ms: 0,
        exe: exe.into(),
    };
    let mut npm = native::Context {
        id: id(1, "/bin/node"),
        cwd: "/somewhere".into(),
        argv: vec!["npm run dev".into()],
        env: BTreeMap::new(),
    };
    let child = native::Context {
        id: id(2, "/bin/sh"),
        cwd: "/project".into(),
        argv: ["sh", "-c", "vite --port '4242'"]
            .iter()
            .map(OsString::from)
            .collect(),
        env: [
            ("npm_execpath", "/lib/npm-cli.js"),
            ("npm_lifecycle_event", "dev"),
            ("npm_package_json", "/project/package.json"),
            ("npm_lifecycle_script", "vite"),
            ("npm_config_script_shell", "/bin/sh"),
        ]
        .map(|(k, v)| (k.into(), v.into()))
        .into(),
    };
    npm::recover(&mut npm, &[child]).unwrap();
    assert_eq!(
        npm.argv,
        [
            "/bin/node",
            "/lib/npm-cli.js",
            "run",
            "dev",
            "--",
            "--port",
            "4242"
        ]
        .map(OsString::from)
    );
}
#[test]
fn invalid_scopes_and_stale_references_do_not_reach_native_controls() {
    let dir = tempdir().unwrap();
    let s = Servers::new(dir.path()).unwrap();
    for invalid in [
        json!({}),
        json!({"refs":[]}),
        json!({"refs":[{"key":"4:65536","firstSeen":1}]}),
        json!({"refs":[{"key":"1:1","firstSeen":1},{"key":"1:1","firstSeen":1}]}),
        json!({"refs":[{"key":"9999:9999","firstSeen":1}]}),
    ] {
        assert!(control::operate(None, &s, "stopServers", invalid).is_err());
    }
}

#[cfg(any(windows, target_os = "macos"))]
struct Owned {
    child: Child,
    // Replacement children are added only after their PID is read from the
    // fixture's environment-checked HTTP response and verified using its cwd.
    dir: PathBuf,
    pids: Vec<Identity>,
}
#[cfg(any(windows, target_os = "macos"))]
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for id in &self.pids {
            if native::identity(id.pid).as_ref() == Some(id) {
                let _ = native::stop(id);
            }
        }
    }
}
#[cfg(any(windows, target_os = "macos"))]
fn node_fixture(root: &Path, name: &str) -> (Owned, Vec<u16>) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("package.json"),
        serde_json::to_vec(&json!({"name":name})).unwrap(),
    )
    .unwrap();
    fs::write(dir.join("server.cjs"),r#"
const http = require("node:http"), fs = require("node:fs");
if (process.env.LOCAL_DASHBOARD_LIVE_TEST_VALUE !== "private-test-only" || process.argv[2] !== 'one "literal" argument') process.exit(14);
const path = require("node:path").join(process.cwd(),"ports.json");
const ports = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [0, 0];
let listening = 0;
for (let i=0; i<ports.length; i++) {
  const server = http.createServer((req,res)=>res.end(String(process.pid)));
  server.listen(ports[i],i ? "::1" : "127.0.0.1",()=>{
    ports[i]=server.address().port;
    if (++listening === ports.length) { fs.writeFileSync(path,JSON.stringify(ports));process.stdout.write(JSON.stringify(ports)+"\n"); }
  });
}
"#).unwrap();
    let mut child = Command::new("node")
        .current_dir(&dir)
        .arg(dir.join("server.cjs"))
        .arg("one \"literal\" argument")
        .env("LOCAL_DASHBOARD_LIVE_TEST_VALUE", "private-test-only")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut text = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut text)
        .unwrap();
    assert!(!text.is_empty());
    let ports = serde_json::from_str(&text).unwrap();
    let identity = native::identity(child.id()).unwrap();
    (
        Owned {
            child,
            dir,
            pids: vec![identity],
        },
        ports,
    )
}
#[cfg(any(windows, target_os = "macos"))]
fn fixture_pid(f: &mut Owned, port: u16) -> u32 {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream, "GET / HTTP/1.0\r\nConnection: close\r\n\r\n").unwrap();
    let mut data = String::new();
    stream.read_to_string(&mut data).unwrap();
    let pid = data
        .rsplit("\r\n\r\n")
        .next()
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    let id = native::identity(pid).unwrap();
    let ctx = Table::default().context(&id).unwrap();
    assert_eq!(project::path_key(&ctx.cwd), project::path_key(&f.dir));
    f.pids.push(id);
    pid
}
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn live_selected_stop_restart_start_and_port_conflict() {
    let root = tempdir().unwrap();
    let storage = root.path().join("data");
    fs::create_dir(&storage).unwrap();
    let servers = Servers::new(&storage).unwrap();
    let (mut f, ports) = node_fixture(root.path(), "server project");
    let (other, other_ports) = node_fixture(root.path(), "unselected");
    // Dashboard descendants are protected in production. Grant the identical
    // capability a verified restart grants, only for the two test-owned identities.
    {
        let mut c = servers.core.lock().unwrap();
        for id in [&f.pids[0], &other.pids[0]] {
            c.allowed.insert(id.pid, id.clone());
        }
    }
    let get_ref = |pid: u32, port: u16| -> Reference {
        servers.core.lock().unwrap().live[&format!("{pid}:{port}")]
            .record
            .reference
            .clone()
    };
    let original = f.child.id();
    let mut stale_identity = f.pids[0].clone();
    stale_identity.started += 1;
    // Same PID and executable with a different creation time must never receive a signal.
    assert!(native::stop(&stale_identity).is_err());
    assert!(native::identity(original).as_ref() == Some(&f.pids[0]));
    for _ in 0..12 {
        scan(None, &servers).unwrap();
        if servers
            .core
            .lock()
            .unwrap()
            .recipes
            .keys()
            .any(|r| r.key == format!("{}:{}", original, ports[0]))
        {
            break;
        }
    }
    let r = get_ref(original, ports[0]);
    let project = {
        let c = servers.core.lock().unwrap();
        let row = c.row(&r).unwrap();
        assert_eq!(row.public["canStop"], true);
        assert_eq!(row.record.project_name.as_deref(), Some("server project"));
        assert_eq!(
            c.live[&format!("{}:{}", original, ports[1])].public["url"],
            format!("http://[::1]:{}", ports[1])
        );
        assert!(
            c.recipes.contains_key(&r),
            "Original exact launch recipe missing"
        );
        row.record.project_id.clone().unwrap()
    };
    let scope = |r: &Reference| json!({"refs":[r],"projectId":project});
    assert!(control::operate(
        None,
        &servers,
        "stopServers",
        json!({"refs":[r],"projectId":"wrong"})
    )
    .is_err());
    {
        let mut c = servers.core.lock().unwrap();
        c.model
            .projects
            .iter_mut()
            .find(|p| p.id == project)
            .unwrap()
            .ignored = true;
    }
    assert!(control::operate(None, &servers, "stopServers", scope(&r)).is_err());
    {
        servers
            .core
            .lock()
            .unwrap()
            .model
            .projects
            .iter_mut()
            .find(|p| p.id == project)
            .unwrap()
            .ignored = false;
    }
    let restarted = control::operate(None, &servers, "restartServer", json!(r)).unwrap();
    assert_eq!(restarted["ok"], true, "{restarted}");
    let replaced = fixture_pid(&mut f, ports[0]);
    assert_ne!(replaced, original);
    assert!(control::operate(None, &servers, "stopServers", scope(&r)).is_err());
    let new_ref = get_ref(replaced, ports[0]);
    {
        let c = servers.core.lock().unwrap();
        let mut t = Table::default();
        t.refresh();
        let id = native::identity(replaced).unwrap();
        let fresh_plan = launch::plan(&t, &id, &native::listeners().unwrap(), &c.allowed);
        assert!(
            fresh_plan.is_ok(),
            "Replacement launcher: {:?}",
            fresh_plan.err()
        );
        assert!(
            c.recipes.contains_key(&new_ref),
            "Replacement launch was not remembered"
        );
    }
    let stopped = control::operate(None, &servers, "stopServers", scope(&new_ref)).unwrap();
    assert_eq!(stopped[0]["ok"], true, "{stopped}");
    assert_eq!(stopped[0]["target"]["ports"].as_array().unwrap().len(), 2);
    assert!(native::identity(replaced).is_none());
    assert!(native::listeners()
        .unwrap()
        .iter()
        .any(|l| l.pid == other.child.id() && l.port == other_ports[0]));
    let conflict = TcpListener::bind(("127.0.0.1", ports[0])).unwrap();
    assert!(control::operate(None, &servers, "startServers", scope(&new_ref)).is_err());
    drop(conflict);
    let started = control::operate(None, &servers, "startServers", scope(&new_ref)).unwrap();
    assert_eq!(started[0]["ok"], true, "{started}");
    let final_pid = fixture_pid(&mut f, ports[0]);
    assert_ne!(final_pid, replaced);
    let final_ref = get_ref(final_pid, ports[0]);
    assert_eq!(
        control::operate(None, &servers, "stopServers", scope(&final_ref)).unwrap()[0]["ok"],
        true
    );
    let persisted = fs::read_to_string(storage.join("projects.json")).unwrap();
    assert!(!persisted.contains("private-test-only"));
    assert!(!persisted.contains("literal"));
    assert!(!persisted.contains("LOCAL_DASHBOARD_LIVE_TEST_VALUE"));
    assert!(persisted.contains("listener-disappeared"));
    assert!(persisted.contains("restarted"));
}

#[cfg(windows)]
#[test]
fn windows_terminal_uses_literal_project_folder_and_system_processes_stay_protected() {
    struct CloseFixture(Identity);
    impl Drop for CloseFixture {
        fn drop(&mut self) {
            if native::identity(self.0.pid).as_ref() == Some(&self.0) {
                let _ = native::stop(&self.0);
            }
        }
    }
    let root = tempdir().unwrap();
    let folder = root.path().join("project & ($literal) বাংলা");
    fs::create_dir(&folder).unwrap();
    let terminal = CloseFixture(windows::open_terminal(&folder.canonicalize().unwrap()).unwrap());
    assert_eq!(classify::basename(&terminal.0.exe), "cmd");
    let mut table = Table::default();
    table.refresh();
    assert!(launch::protected(&table, &terminal.0, &HashMap::new()));
    let ctx = table.context(&terminal.0).unwrap();
    assert_eq!(project::path_key(&ctx.cwd), project::path_key(&folder));
    assert_eq!(&ctx.argv[1..], &["/d", "/k"].map(OsString::from));
    let pid = terminal.0.pid;
    drop(terminal);
    assert!(native::identity(pid).is_none());
}

#[cfg(windows)]
#[test]
fn dashboard_ancestry_and_application_classification_require_positive_evidence() {
    let mut table = Table::default();
    table.refresh();
    let own = native::identity(std::process::id()).unwrap();
    assert!(launch::protected(&table, &own, &HashMap::new()));
    if let Some(parent) = table.parent(own.pid).and_then(native::identity) {
        assert!(launch::protected(&table, &parent, &HashMap::new()));
    }
    let browser = Identity {
        pid: 1_900_000_000,
        started: 1,
        unix_ms: 1,
        exe: "C:/Portable/Chrome/chrome.exe".into(),
    };
    let classified = classify::classify(&table, Some(&browser), "chrome.exe", None, &[]);
    assert_eq!(classified.discovery, "application");
    assert_eq!(classified.app.unwrap()["name"], "Google Chrome");
    let node = Identity {
        exe: "C:/Program Files/nodejs/node.exe".into(),
        ..browser
    };
    let bare = classify::classify(&table, Some(&node), "node.exe", None, &[]);
    assert_eq!(bare.discovery, "unidentified");
    let development = classify::classify(
        &table,
        Some(&node),
        "node.exe",
        None,
        &["node".into(), "project.cjs".into()],
    );
    assert_eq!(development.discovery, "development");
}
