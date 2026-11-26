use super::{
    changes,
    discovery::{self, Environment},
    inventory, migrate,
    model::*,
    packages,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

fn isolated(root: &Path, directories: &[PathBuf]) -> Environment {
    Environment {
        home: root.into(),
        vars: BTreeMap::new(),
        dirs: directories
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), Some(i)))
            .collect(),
        neutral: root.into(),
        extensions: vec![
            "com".into(),
            "exe".into(),
            "cmd".into(),
            "bat".into(),
            "ps1".into(),
        ],
        additional: vec![],
        #[cfg(windows)]
        registry: None,
    }
}
fn file(p: &Path, data: impl AsRef<[u8]>) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, data).unwrap();
}
fn fixture_pe(subsystem: u16) -> Vec<u8> {
    let mut v = vec![0; 160];
    v[..2].copy_from_slice(b"MZ");
    v[60..64].copy_from_slice(&64u32.to_le_bytes());
    v[64..68].copy_from_slice(b"PE\0\0");
    v[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
    v[156..158].copy_from_slice(&subsystem.to_le_bytes());
    v
}
fn scan(e: &Environment, p: &Value) -> Value {
    inventory::scan(e, p, &AtomicBool::new(false), None, &|_, _, _, _| {}).unwrap()
}
#[test]
fn pipx_pins_the_home_proven_by_installed_application_paths() {
    use super::{discovery::Endpoint, runner::Plan};
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("legacy-pipx-home");
    let app = home.join("venvs/demo/Scripts/demo.exe");
    file(&app, b"fixture");
    let bin = tmp.path().join("pipx.exe");
    file(&bin, b"fixture manager");
    let manager = Plan::new(&bin, &[]);
    let ep = Endpoint {
        path: bin.clone(),
        canonical: bin,
        name: "pipx".into(),
        ext: "exe".into(),
        order: Some((0, 0)),
        data: json!({"executable":true}),
    };
    let raw = json!({"venvs":{"demo":{"metadata":{"main_package":{
        "apps":["demo"],"app_paths":[{"__Path__":app}],"package_version":"1.2"
    }}}}})
    .to_string();
    let mut env = isolated(tmp.path(), &[]);
    let parse = |env: &Environment| {
        packages::manager_output("pipx", &raw, env, &manager, &ep, &[])
            .unwrap()
            .remove(0)
            .identity
    };
    assert_eq!(parse(&env)["managerRoot"], path_string(&real(&home)));
    assert_eq!(parse(&env)["ownershipConfidence"], "exact");
    env.vars
        .insert("PIPX_HOME".into(), tmp.path().join("different-home"));
    assert_eq!(parse(&env)["ownershipConfidence"], "corroborated");
    env.vars.insert("PIPX_HOME".into(), home);
    fs::remove_file(app).unwrap();
    assert_eq!(parse(&env)["ownershipConfidence"], "corroborated");
}
#[test]
fn homebrew_and_macports_owned_bin_contracts_are_fixture_testable_on_windows() {
    use super::{discovery::Endpoint, runner::Plan};
    let t = tempfile::tempdir().unwrap();
    let prefix = t.path();
    let brew = prefix.join("bin/brew");
    file(&brew, b"fixture");
    let exe = prefix.join("Cellar/widget@2/2.1/bin/widget");
    file(&exe, b"fixture");
    let cask_bin = prefix.join("Application.app/Contents/MacOS/widgetapp");
    file(&cask_bin, b"fixture");
    let ep = Endpoint {
        path: brew.clone(),
        canonical: brew.clone(),
        name: "brew".into(),
        ext: String::new(),
        order: Some((0, 0)),
        data: json!({"executable":true}),
    };
    let env = isolated(prefix, &[]);
    let p = Plan::new(&brew, &[]);
    let input = json!({
        "formulae": [{},{"full_name":"widget@2","linked_keg":"2.1"}],
        "casks": [{"token":"widgetapp","version":"1.0","artifacts":[{"binary":[cask_bin]}]}],
    });
    let rows =
        packages::manager_output("homebrew", &input.to_string(), &env, &p, &ep, &[]).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].identity["source"], "homebrew-formula");
    assert!(rows[0].bins.contains_key("widget"));
    assert_eq!(rows[1].identity["source"], "homebrew-cask");
    assert!(rows[1].bins.contains_key("widgetapp"));
    assert!(packages::manager_output("homebrew", "malformed", &env, &p, &ep, &[]).is_none());
    assert!(packages::manager_output("macports", "", &env, &p, &ep, &[])
        .unwrap()
        .is_empty());
}
#[test]
#[cfg(windows)]
fn console_admission_shims_and_exact_node_bins() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let bin = root.join("portable");
    let outside = root.join("extra");
    file(&bin.join("unknown-cli.exe"), fixture_pe(3));
    file(&bin.join("gui.exe"), fixture_pe(2));
    file(&bin.join("fake.exe"), b"MZ");
    file(
        &bin.join("tool.cmd"),
        r#"@"node" "%~dp0node_modules\demo-pkg\bin\tool.js" %*"#,
    );
    file(
        &bin.join("tool.ps1"),
        r#"& node "$basedir/node_modules/demo-pkg/bin/tool.js" $args"#,
    );
    file(&bin.join("tool"), "#!/bin/sh\n");
    let pkg = bin.join("node_modules/demo-pkg");
    file(
        &pkg.join("package.json"),
        r#"{"name":"demo-pkg","version":"2.0","bin":{"tool":"bin/tool.js","bad":"../../escape"}}"#,
    );
    file(&pkg.join("bin/tool.js"), "");
    file(&root.join("escape"), "");
    file(&outside.join("deep/folder/other-tool.cmd"), "@echo off");
    file(&outside.join("node_modules/omitted.exe"), fixture_pe(3));
    let mut env = isolated(root, std::slice::from_ref(&bin));
    env.additional.push(outside);
    let s = scan(&env, &Value::Null);
    let products = list(&s, "products");
    let candidate = products
        .iter()
        .find(|p| p["commandNames"] == json!(["unknown-cli"]))
        .unwrap();
    assert_eq!(list(candidate, "currentInstallationIds").len(), 0);
    assert_eq!(list(candidate, "candidateInstallationIds").len(), 1);
    for n in ["gui", "fake", "bad", "omitted"] {
        assert!(!list(&s, "commands").iter().any(|c| c["name"] == n))
    }
    let known = products
        .iter()
        .find(|p| p["commandNames"] == json!(["tool"]))
        .unwrap();
    assert_eq!(list(known, "currentInstallationIds").len(), 1);
    let inst = find(&s, "installations", &known["currentInstallationIds"][0]).unwrap();
    assert_eq!(inst["discoveryKind"], "package-command");
    assert!(list(inst, "endpointIds").len() >= 3);
    let tp = list(&s, "commands")
        .iter()
        .find(|c| c["name"] == "tool" && c["pathRole"] == "active")
        .unwrap();
    assert!(text(
        find(&s, "endpoints", &tp["activeEndpointId"]).unwrap(),
        "path"
    )
    .ends_with("tool.cmd"));
    assert!(list(&s, "commands")
        .iter()
        .any(|c| c["name"] == "other-tool" && c["pathRole"] == "not-on-path"));
    assert!(!list(&s, "endpoints")
        .iter()
        .any(|e| text(e, "path").ends_with("tool") && e["pathIndex"].is_number()));
    let mut prior = s.clone();
    let id = &candidate["candidateInstallationIds"][0];
    let user = prior["installations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|i| &i["id"] == id)
        .unwrap();
    let first = user["firstSeenAt"].clone();
    user["includedByUser"] = json!(true);
    let next = scan(&env, &prior);
    let candidate = find(&next, "installations", id).unwrap();
    assert_eq!(candidate["discoveryKind"], "user");
    assert_eq!(candidate["firstSeenAt"], first);
}
#[test]
#[cfg(windows)]
fn registry_evidence_and_probe_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let runner = root.path().join("kit/bin");
    let env = isolated(root.path(), std::slice::from_ref(&runner));
    file(
        &runner.join("pnpm.cmd"),
        r#"@"node" "%~dp0node_modules\corepack\dist\pnpm.js" %*"#,
    );
    file(&runner.join("unknown.cmd"), "@echo off");
    file(&runner.join("wrapper.cmd"), "@\"%~dp0missing.exe\" %*\n");
    let (ep, _) = discovery::enumerate(&env, &AtomicBool::new(false)).unwrap();
    let pnpm = ep.iter().find(|e| e.name == "pnpm").unwrap();
    assert!(packages::probe_plan(pnpm, &ep, &["--version".into()]).is_none());
    let wrap = ep.iter().find(|e| e.name == "wrapper").unwrap();
    assert_eq!(wrap.data["targetExists"], false);
    assert!(packages::child_path(root.path(), "../escape.exe").is_none());
    assert!(packages::child_path(root.path(), r"C:\outside.exe").is_none());
}
#[test]
#[cfg(windows)]
fn python_console_script_uv_and_cargo_use_declared_ownership_only() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let py = root.join("python/Scripts");
    let info = root.join("python/Lib/site-packages/widget-2.0.dist-info");
    file(&py.join("widget.exe"), fixture_pe(3));
    file(&py.join("widget-gui.exe"), fixture_pe(2));
    file(
        &info.join("METADATA"),
        "Name: widget-package\nVersion: 2.0\n",
    );
    file(
        &info.join("entry_points.txt"),
        "[console_scripts]\nwidget = main:run\n[gui_scripts]\nwidget-gui = main:gui\n",
    );
    let cargo = root.join(".cargo");
    file(&cargo.join("bin/pkg-run.exe"), fixture_pe(3));
    file(
        &cargo.join(".crates2.json"),
        r#"{"installs":{"example-cli 1.2.0 (registry+https://example.com)":{"bins":["pkg-run.exe"]}}}"#,
    );
    let uv = root.join(".local/share/uv/tools/sample/uv-receipt.toml");
    file(&py.join("sample.exe"), fixture_pe(3));
    file(&uv,format!("[tool]\nrequirements = [{{name = \"sample-tool\"}}]\nentrypoints = [{{name = \"sample.exe\", install-path = {}}}]\n",json!(py.join("sample.exe"))));
    let s = scan(&isolated(root, &[py, cargo.join("bin")]), &Value::Null);
    for (source, n) in [
        ("pip", "widget-package"),
        ("cargo", "example-cli"),
        ("uv", "sample-tool"),
    ] {
        assert!(list(&s, "installations")
            .iter()
            .any(|i| i["packageIdentity"]["source"] == source
                && i["packageIdentity"]["packageId"] == n));
    }
    assert!(!list(&s, "commands")
        .iter()
        .any(|c| c["name"] == "widget-gui"));
}
#[test]
#[cfg(windows)]
fn lifecycle_changes_require_actual_absence_and_match_path_aliases() {
    let t = tempfile::tempdir().unwrap();
    let bin = t.path().join("bin");
    let file_path = bin.join("eas.cmd");
    file(&file_path, "@echo off");
    let e = isolated(t.path(), std::slice::from_ref(&bin));
    let a = scan(&e, &Value::Null);
    let mut b = a.clone();
    b["installations"] = json!([]);
    b["commands"] = json!([]);
    assert_eq!(changes::compare(&a, &b)["entries"][0]["kind"], "uncertain");
    fs::remove_file(&file_path).unwrap();
    assert_eq!(changes::compare(&a, &b)["entries"][0]["kind"], "removed");
    b["completeness"] = json!("partial");
    assert_eq!(changes::compare(&a, &b)["entries"][0]["kind"], "uncertain");
    let mut old = a.clone();
    old["schemaVersion"] = json!(1);
    let mut second = old["installations"][0].clone();
    second["id"] = json!("old-shim-id");
    let mut ep = old["endpoints"][0].clone();
    ep["id"] = json!("old-ep-id");
    ep["path"] = json!(bin.join("eas.ps1"));
    ep["canonicalPath"] = ep["path"].clone();
    second["endpointIds"] = json!(["old-ep-id"]);
    old["installations"].as_array_mut().unwrap().push(second);
    old["endpoints"].as_array_mut().unwrap().push(ep);
    let store = migrate(&json!({"schemaVersion":1,"inventory":old})).unwrap();
    assert_eq!(store["inventory"]["schemaVersion"], 2);
    assert_eq!(list(&store["inventory"], "installations").len(), 1);
    assert_eq!(
        list(&store["inventory"]["installations"][0], "endpointIds").len(),
        2
    );
}
