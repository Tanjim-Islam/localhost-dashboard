use super::{actions, inventory::capability, model::*};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn installation(root: &Path, source: &str, manager: &str, package: &str) -> Value {
    let path = root.join(manager);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"fixture").unwrap();
    let mut identity = json!({
        "source": source,
        "packageId": package,
        "packageVersion": "1.0",
        "scope": "user",
        "managerRoot": root,
        "managerExecutablePath": path,
        "installRoot": root.join("packages").join(package),
        "ownershipConfidence": "exact",
        "uninstallEvidence": if source=="scoop"{"simple-manifest"}else{"manager-owned"},
    });
    if source == "npm" {
        let entry = root.join("node_modules/npm/bin/npm-cli.js");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, b"fixture").unwrap();
        identity["managerCommandPath"] = json!(entry);
    }
    let cap = capability(
        &identity,
        "fixture",
        "package-manager",
        &["fixture".into(), "fixture-alt".into()],
    );
    json!({
        "id": "cli-fixture",
        "productId": "fixture",
        "presence": "present",
        "scope": "user",
        "origin": "package-manager",
        "fingerprint": "fp-unchanged",
        "endpointIds": ["ep-fixture"],
        "packageIdentity": identity,
        "uninstallCapability": cap,
    })
}
#[test]
fn exact_manager_plans_only_and_immutable_preview_evidence() {
    let root = tempfile::tempdir().unwrap();
    let name = "test-package";
    for (source, manager) in [
        ("npm", "node.exe"),
        ("cargo", "cargo.exe"),
        ("pipx", "pipx.exe"),
        ("homebrew-formula", "brew"),
        ("scoop", "scoop.ps1"),
    ] {
        if source == "scoop" && !cfg!(windows) {
            continue;
        }
        let mut i = installation(root.path(), source, manager, name);
        let p = actions::plan(&i).unwrap();
        assert!(p.exe.is_absolute());
        assert_eq!(p.args.last().unwrap(), name);
        match source {
            "npm" => assert!(p.args[1..].starts_with(&[
                "uninstall".to_owned(),
                "--global".into(),
                "--prefix".into(),
                path_string(root.path()),
                "--ignore-scripts".into()
            ])),
            "cargo" => assert_eq!(
                p.args[..4],
                [
                    "uninstall",
                    "--root",
                    &path_string(root.path()),
                    "--package"
                ]
            ),
            "scoop" => {
                assert!(p.args.starts_with(
                    &[
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File"
                    ]
                    .map(str::to_owned)
                ));
                assert!(p.env.contains(&("SCOOP".into(), path_string(root.path()))));
            }
            "pipx" => {
                assert_eq!(p.args, ["uninstall", name]);
                assert!(p
                    .env
                    .contains(&("PIPX_HOME".into(), path_string(root.path()))));
            }
            "homebrew-formula" => assert_eq!(&p.args[..2], ["uninstall", "--formula"]),
            _ => assert_eq!(p.args.len(), 2),
        }
        let snap = json!({
            "installations": [i],
            "commands": [{"installationId":"cli-fixture","name":"fixture","endpointIds":["ep-fixture"]}],
            "endpoints": [{"id":"ep-fixture","path":root.path().join("fixture"),"fingerprint":"fp-endpoint"}],
        });
        let endpoint = root.path().join("fixture");
        fs::write(&endpoint, b"fixture").unwrap();
        let e = actions::evidence(&snap, &i).unwrap();
        // The dispatcher exercises exactly the production verification path; only the process runner is replaced.
        assert!(actions::execute(&snap, &i, &e, |actual| {
            assert_eq!(actual.exe, p.exe);
            assert_eq!(actual.args, p.args);
            Ok(String::new())
        })
        .unwrap());
        assert!(
            !actions::execute(&snap, &i, &e, |_| Err("Simulated manager error".into())).unwrap()
        );
        let mut stale = i.clone();
        stale["scope"] = json!("machine");
        assert!(
            actions::execute(&snap, &stale, &e, |_| panic!("stale scope invoked manager")).is_err()
        );
        let original_stamp = fs::metadata(&endpoint).unwrap().modified().unwrap();
        fs::write(&endpoint, b"changed").unwrap();
        fs::File::options()
            .write(true)
            .open(&endpoint)
            .unwrap()
            .set_modified(original_stamp)
            .unwrap();
        assert!(actions::execute(&snap, &i, &e, |_| panic!(
            "replaced endpoint invoked manager"
        ))
        .is_err());
        fs::write(root.path().join(manager), b"fixture changed").unwrap();
        assert!(actions::check_same(&e, &actions::evidence(&snap, &i).unwrap()).is_err());
        i["packageIdentity"]["packageId"] = json!("-override");
        assert!(actions::plan(&i).is_err());
    }
}
#[test]
fn unsupported_and_foundational_sources_cannot_reach_execution() {
    for source in [
        "winget",
        "chocolatey",
        "pnpm",
        "yarn-classic",
        "bun",
        "macports",
        "homebrew-cask",
        "registry",
        "pip",
        "uv",
        "appx-alias",
        "standalone",
        "unknown",
    ] {
        let identity = json!({"source":source,"packageId":"widget","ownershipConfidence":"exact"});
        let cap = capability(&identity, "widget", "package-manager", &["widget".into()]);
        assert!(
            matches!(text(&cap, "status"), "blocked" | "manual-only"),
            "{source}"
        );
        assert!(actions::plan(
            &json!({"presence":"present","packageIdentity":identity,"uninstallCapability":cap})
        )
        .is_err());
    }
    let exact = json!({"source":"npm","packageId":"widget","ownershipConfidence":"exact"});
    for origin in ["sdk-bundled", "application-embedded"] {
        assert_eq!(
            capability(&exact, "widget", origin, &["widget".into()])["reasonCode"],
            "embedded-tool"
        );
    }
    let uncertain = json!({"source":"npm","packageId":"widget","ownershipConfidence":"uncertain"});
    assert_eq!(
        capability(&uncertain, "widget", "package-manager", &["widget".into()])["reasonCode"],
        "identity-uncertain"
    );
    assert_eq!(
        capability(
            &exact,
            "widget",
            "package-manager",
            &["widget".into(), "node".into()]
        )["reasonCode"],
        "foundational-tool"
    );
    assert_eq!(
        capability(&Value::Null, "widget", "user", &["widget".into()])["reasonCode"],
        "standalone-binary"
    );
    assert!(!actions::supported(
        &json!({"presence":"unknown","uninstallCapability":{"status":"supported"},"packageIdentity":exact})
    ));
}
#[test]
fn wheel_checksum_resolves_competing_console_entry_points() {
    use super::{discovery::Environment, inventory};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::atomic::AtomicBool};
    if !cfg!(windows) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let scripts = root.path().join("Scripts");
    fs::create_dir(&scripts).unwrap();
    let exe = scripts.join("sample.exe");
    fs::write(&exe, b"fixture").unwrap();
    let valid = URL_SAFE_NO_PAD.encode(Sha256::digest(b"fixture"));
    // A catalogued native command in this same folder gives the Python adapter its Scripts root.
    fs::write(scripts.join("nvm.exe"), b"fixture").unwrap();
    for (n, digest) in [
        ("package-old", "wrong"),
        ("package-current", valid.as_str()),
    ] {
        let info = root
            .path()
            .join("Lib/site-packages")
            .join(format!("{n}.dist-info"));
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("METADATA"), format!("Name: {n}\nVersion: 1.0\n")).unwrap();
        fs::write(
            info.join("entry_points.txt"),
            "[console_scripts]\nsample = pkg:main\n",
        )
        .unwrap();
        fs::write(
            info.join("RECORD"),
            format!("../../Scripts/sample.exe,sha256={digest},7\n"),
        )
        .unwrap();
    }
    let env = Environment {
        home: root.path().into(),
        neutral: root.path().into(),
        vars: BTreeMap::new(),
        dirs: vec![(scripts, Some(0))],
        extensions: vec!["exe".into()],
        additional: vec![],
        #[cfg(windows)]
        registry: None,
    };
    let snapshot = inventory::scan(
        &env,
        &Value::Null,
        &AtomicBool::new(false),
        None,
        &|_, _, _, _| {},
    )
    .unwrap();
    assert!(list(&snapshot, "installations")
        .iter()
        .any(|i| i["packageIdentity"]["packageId"] == "package-current"));
    assert!(!list(&snapshot, "installations")
        .iter()
        .any(|i| i["packageIdentity"]["packageId"] == "package-old"));
}
