use super::{
    discovery::stopped,
    inventory::{capability, products, Progress},
    model::*,
};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path, sync::atomic::AtomicBool, time::Duration};
pub(super) fn scan(
    root: &Path,
    removed: &BTreeSet<String>,
    old: &Value,
    cancel: &AtomicBool,
    progress: &Progress,
) -> Result<Value, String> {
    let stamp = now();
    for name in ["npm/node.exe", "npm/node_modules/npm/bin/npm-cli.js"] {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap())
            .map_err(|_| "Cannot initialize fixture manager.")?;
        if !path.exists() {
            fs::write(&path, b"fixture manager").map_err(|_| "Cannot write fixture manager.")?;
        }
    }
    let mut installs = vec![];
    let mut commands = vec![];
    let mut endpoints = vec![];
    for (i, (stage, label)) in [
        ("revalidating-cache", "Revalidating cached data"),
        ("enumerating-path", "Enumerating PATH directories"),
        ("reading-package-sources", "Reading package sources"),
        ("matching-installations", "Matching installations"),
        ("checking-versions", "Checking versions"),
        ("finalizing", "Finalizing inventory"),
    ]
    .iter()
    .enumerate()
    {
        stopped(cancel)?;
        progress(stage, label, i, 6);
        std::thread::sleep(Duration::from_millis(45));
    }
    for (product, cmd, version, file, owner, health) in [
        (
            "codex",
            "codex",
            "0.62.0",
            "path-a/codex.cmd",
            "@openai/codex",
            "healthy",
        ),
        (
            "opencode",
            "opencode",
            "1.2.4",
            "path-a/opencode.cmd",
            "opencode-ai",
            "healthy",
        ),
        ("bun", "bun", "1.1.8", "path-a/bun.exe", "", "healthy"),
        ("bun", "bun", "1.2.20", "path-b/bun.exe", "", "healthy"),
        (
            "python",
            "python",
            "3.13.5",
            "path-a/python.cmd",
            "",
            "broken",
        ),
        (
            "dotnet",
            "dotnet",
            "9.0.7",
            "path-a/dotnet.exe",
            "",
            "incomplete",
        ),
    ] {
        let path = root.join(file);
        let inst_id = id("cli", json!({"fixture":file}));
        if removed.contains(&inst_id) {
            continue;
        }
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Cannot initialize fixture.")?;
        if !path.exists() {
            fs::write(&path, b"fixture\n").map_err(|_| "Cannot write CLI fixture.")?;
        }
        let ep_id = id("endpoint", json!({"fixture":file}));
        let cid = id("command", json!({"installationId":inst_id,"name":cmd}));
        let fp = id("fp", json!({"fixture":file}));
        let shadow = file.starts_with("path-b");
        let issues = match health {
            "broken" => vec!["broken-shim", "missing-target"],
            "incomplete" => vec!["incomplete-installation"],
            _ if shadow => vec!["path-conflict", "shadowed"],
            _ if product == "bun" => vec!["path-conflict"],
            _ => vec![],
        };
        let ident = if owner.is_empty() {
            Value::Null
        } else {
            json!({
                "source": "npm",
                "packageId": owner,
                "packageVersion": version,
                "scope": "user",
                "managerRoot": root.join("npm"),
                "managerExecutablePath": root.join("npm/node.exe"),
                "managerCommandPath": root.join("npm/node_modules/npm/bin/npm-cli.js"),
                "installRoot": root.join("npm/node_modules").join(owner),
                "ownershipConfidence": "exact",
                "uninstallEvidence": "manager-owned",
            })
        };
        let cap = capability(&ident, product, "user", &[cmd.to_owned()]);
        let first = find(old, "installations", &json!(inst_id))
            .and_then(|i| i["firstSeenAt"].as_u64())
            .unwrap_or(stamp);
        let mut inst = json!({
            "id": inst_id,
            "productId": product,
            "platform": platform(),
            "architecture": arch(),
            "origin": if owner.is_empty(){"user"}else{"package-manager"},
            "scope": "user",
            "discoveryKind": "catalogue",
            "version": version,
            "versionSource": if owner.is_empty(){"version-probe"}else{"package-metadata"},
            "verificationStatus": "partially-verified",
            "endpointIds": [ep_id],
            "commandIds": [cid],
            "fingerprint": fp,
            "presence": "present",
            "health": health,
            "issueCodes": issues,
            "firstSeenAt": first,
            "lastSeenAt": stamp,
            "lastVerifiedAt": stamp,
            "uninstallCapability": cap,
        });
        if !ident.is_null() {
            inst["packageIdentity"] = ident;
        }
        installs.push(inst);
        let mut command = json!({
            "id": cid,
            "productId": product,
            "installationId": inst_id,
            "name": cmd,
            "endpointIds": [ep_id],
            "pathRole": if shadow{"shadowed"}else{"active"},
        });
        if !shadow {
            command["activeEndpointId"] = json!(ep_id);
        }
        commands.push(command);
        endpoints.push(json!({
            "id": ep_id,
            "commandName": cmd,
            "kind": if file.ends_with("cmd"){"shim"}else{"native"},
            "path": path,
            "canonicalPath": path,
            "pathIndex": if shadow{1}else{0},
            "pathextIndex": 1,
            "accessible": true,
            "executable": true,
            "targetExists": health!="broken",
            "fingerprint": fp,
        }));
    }
    let mut s = json!({
        "schemaVersion": 2,
        "revision": uuid::Uuid::new_v4().to_string(),
        "platform": platform(),
        "architecture": arch(),
        "generatedAt": stamp,
        "completeness": "partial",
        "cached": false,
        "products": [],
        "commands": commands,
        "endpoints": endpoints,
        "installations": installs,
        "sourceResults": [source("fixture-path","Fixture PATH","success",6,stamp),source("fixture-npm","Fixture npm","success",2,stamp),source("fixture-partial","Fixture unavailable source","failed",0,stamp)],
    });
    products(&mut s);
    Ok(s)
}
