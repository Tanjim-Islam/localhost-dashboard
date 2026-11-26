use super::*;
use std::sync::atomic::AtomicBool;

fn prepared() -> (tempfile::TempDir, Clis, Value) {
    let dir = tempfile::tempdir().unwrap();
    let c = Clis::open(dir.path(), Some(dir.path().into())).unwrap();
    let session = c.begin().unwrap();
    let snapshot = c.manual(session, &|_, _| {}).unwrap();
    (dir, c, snapshot)
}
fn reference(s: &Value, name: &str) -> Value {
    let i = list(s, "installations")
        .iter()
        .find(|i| i["productId"] == name)
        .unwrap();
    json!({"installationId":i["id"],"inventoryRevision":s["revision"]})
}
#[test]
fn fixture_scan_cancel_preserves_last_inventory() {
    let (dir, c, s) = prepared();
    assert_eq!(s["completeness"], "partial");
    assert_eq!(list(&s, "installations").len(), 6);
    let started = c.begin().unwrap();
    assert!(c.begin().is_err());
    c.lock()
        .unwrap()
        .cancel
        .as_ref()
        .unwrap()
        .store(true, Ordering::Release);
    assert!(c.manual(started, &|_, _| {}).is_err());
    assert_eq!(
        c.lock().unwrap().store["inventory"]["revision"],
        s["revision"]
    );
    drop(c);
    let loaded = Clis::open(dir.path(), Some(dir.path().into())).unwrap();
    assert_eq!(
        loaded.lock().unwrap().store["inventory"]["revision"],
        s["revision"]
    );
    assert!(loaded.lock().unwrap().cancel.is_none());
}
#[test]
fn fixture_uninstall_consumes_ownership_token_and_refreshes() {
    let (_dir, c, s) = prepared();
    for (product, expected) in [("opencode", "failed"), ("codex", "succeeded")] {
        let current = c.lock().unwrap().store["inventory"].clone();
        let mut req = reference(&current, product);
        let preview = c
            .action("getCliUninstallPreview", &req, &|_, _| {})
            .unwrap();
        req["previewToken"] = preview["token"].clone();
        req["confirmation"] = json!("uninstall-exact-cli-installation");
        let removed = c
            .action("uninstallCliInstallation", &req, &|_, _| {})
            .unwrap();
        assert_eq!(removed["status"], expected);
        assert!(c
            .action("uninstallCliInstallation", &req, &|_, _| {})
            .is_err());
    }
    assert!(c
        .action(
            "getCliUninstallPreview",
            &reference(&s, "codex"),
            &|_, _| {}
        )
        .is_err());
    let state = c.lock().unwrap();
    assert_eq!(list(&state.store, "uninstallAudits").len(), 2);
    assert!(!list(&state.store["inventory"], "installations")
        .iter()
        .any(|i| i["productId"] == "codex"));
}
#[test]
fn bounded_runner_uses_absolute_executable_and_terminates_timeout() {
    let tmp = tempfile::tempdir().unwrap();
    let c = AtomicBool::new(false);
    assert!(runner::run(
        &runner::Plan::new(Path::new("foo"), &[]),
        tmp.path(),
        &c,
        Duration::from_millis(500),
        64
    )
    .is_err());
    #[cfg(windows)]
    {
        let sys = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap()
            .join("System32");
        let p = runner::Plan::new(&sys.join("whoami.exe"), &[]);
        assert!(
            !runner::run(&p, tmp.path(), &c, Duration::from_secs(10), 1024)
                .unwrap()
                .trim()
                .is_empty()
        );
        assert!(runner::run(&p, tmp.path(), &c, Duration::from_secs(10), 1).is_err());
        let p = runner::Plan::new(&sys.join("ping.exe"), &["-n", "4", "127.0.0.1"]);
        assert!(runner::run(&p, tmp.path(), &c, Duration::from_millis(250), 8192).is_err());
    }
}
#[test]
fn catalogue_and_source_boundaries() {
    assert_eq!(CATALOGUE.len(), 91);
    for n in ["npx", "nvm", "firebase"] {
        assert!(by_command(n).unwrap().version_probe.is_none());
    }
    for bad in ["--option", "../../bad", "@scope/../x", "x y", "$tool"] {
        assert!(!valid_pkg("npm", bad));
    }
    assert!(valid_pkg("npm", "@scope/cli"));
    assert!(valid_pkg("homebrew-formula", "acme/tap/tool"));
    let c = inventory::capability(
        &json!({"source":"npm","ownershipConfidence":"exact"}),
        "test",
        "user",
        &["node".into()],
    );
    assert_eq!(c["status"], "manual-only");
    let c = inventory::capability(
        &json!({"source":"scoop","ownershipConfidence":"exact","uninstallEvidence":"none"}),
        "test",
        "user",
        &["test".into()],
    );
    assert_eq!(c["status"], "manual-only");
}
#[test]
fn expired_and_mismatched_tokens_are_single_use() {
    let mut tickets = BTreeMap::new();
    let token = uuid::Uuid::new_v4().to_string();
    let req = json!({"confirmation":"uninstall-exact-cli-installation","previewToken":token,"installationId":"cli-inventory","inventoryRevision":"inv-changed"});
    for (rev, expires) in [("inv-original", now() + 60000), ("inv-changed", now() - 1)] {
        tickets.insert(
            token.clone(),
            Ticket {
                revision: rev.into(),
                expires,
                installation: "cli-inventory".into(),
                evidence: Value::Null,
            },
        );
        assert!(actions::consume(&mut tickets, &req).is_err());
        assert!(tickets.is_empty());
    }
}
#[test]
#[ignore = "read-only live Windows inventory audit"]
fn live_cli_inventory() {
    assert!(cfg!(windows));
    let t = tempfile::tempdir().unwrap();
    let c = Clis::open(t.path(), None).unwrap();
    assert!(!t.path().join("cli-neutral").exists());
    let start = c.begin().unwrap();
    let snapshot = c
        .manual(start, &|event, v| {
            if event == "onCliScanProgress" {
                eprintln!(
                    "{} {}/{}",
                    text(v, "stage"),
                    v["completedSources"],
                    v["totalSources"]
                );
            }
        })
        .unwrap();
    assert!(list(&snapshot, "installations")
        .iter()
        .any(|v| v["productId"] == "node"));
    assert!(list(&snapshot, "installations")
        .iter()
        .any(|v| v["productId"] == "cargo"));
    assert!(list(&snapshot, "commands").iter().all(|cmd| find(
        &snapshot,
        "installations",
        &cmd["installationId"]
    )
    .is_some()));
    for s in list(&snapshot, "sourceResults") {
        eprintln!("{}: {} ({})", s["label"], s["status"], s["recordCount"]);
    }
    let current: Vec<_> = list(&snapshot, "products")
        .iter()
        .filter(|p| !list(p, "currentInstallationIds").is_empty())
        .collect();
    let candidates = list(&snapshot, "installations")
        .iter()
        .filter(|i| i["discoveryKind"] == "candidate")
        .count();
    let bundled = list(&snapshot, "installations")
        .iter()
        .filter(|i| matches!(text(i, "origin"), "application-embedded" | "sdk-bundled"))
        .count();
    let eligible = list(&snapshot, "installations")
        .iter()
        .filter(|i| actions::supported(i))
        .count();
    assert!(current
        .iter()
        .all(|p| strings(&p["currentInstallationIds"]).all(|id| find(
            &snapshot,
            "installations",
            &json!(id)
        )
        .is_some_and(|i| i["discoveryKind"] != "candidate"
            && !matches!(text(i, "origin"), "application-embedded" | "sdk-bundled")))));
    eprintln!("{} installed products, {candidates} candidate installations, {bundled} bundled installations, {eligible} uninstall-eligible installations",current.len());
    if let Some(path) = std::env::var_os("LOCAL_DASHBOARD_CLI_AUDIT_OUTPUT") {
        fs::write(path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    }
    eprintln!(
        "{} products, {} installations, {} commands, {} endpoints",
        list(&snapshot, "products").len(),
        list(&snapshot, "installations").len(),
        list(&snapshot, "commands").len(),
        list(&snapshot, "endpoints").len()
    );
}
