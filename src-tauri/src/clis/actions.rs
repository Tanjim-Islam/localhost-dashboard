use super::{model::*, runner::Plan};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub(super) struct Ticket {
    pub expires: u64,
    pub installation: String,
    pub revision: String,
    pub evidence: Value,
}
pub(super) fn supported(i: &Value) -> bool {
    matches!(
        text(&i["uninstallCapability"], "status"),
        "supported" | "requires-warning"
    ) && i["presence"] == "present"
        && i["packageIdentity"]["ownershipConfidence"] == "exact"
}
pub(super) fn plan(i: &Value) -> Result<Plan, String> {
    if !supported(i) {
        return Err("This installation cannot be uninstalled automatically.".into());
    }
    let owner = &i["packageIdentity"];
    let src = text(owner, "source");
    let package = text(owner, "packageId");
    let exe = Path::new(text(owner, "managerExecutablePath"));
    let root = Path::new(text(owner, "managerRoot"));
    if !valid_pkg(src, package)
        || !exe.is_absolute()
        || !exe.is_file()
        || !root.is_absolute()
        || !root.is_dir()
    {
        return Err("Exact package manager evidence is unavailable.".into());
    }
    let name = exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let same = |base: &str| name == base || name == format!("{base}.exe");
    let mut result = match src {
        "npm" if same("npm") || same("node") => {
            let mut p = Plan::new(exe, &[]);
            if same("node") {
                let cmd = PathBuf::from(text(owner, "managerCommandPath"));
                if !cmd.is_absolute()
                    || !cmd.is_file()
                    || !normal(&cmd)
                        .replace('\\', "/")
                        .ends_with("/node_modules/npm/bin/npm-cli.js")
                {
                    return Err("The exact npm command is unavailable.".into());
                }
                p.args.push(path_string(&cmd));
            }
            p.args.extend(
                [
                    "uninstall",
                    "--global",
                    "--prefix",
                    text(owner, "managerRoot"),
                    "--ignore-scripts",
                    package,
                ]
                .map(str::to_owned),
            );
            p.env
                .push(("npm_config_ignore_scripts".into(), "true".into()));
            p
        }
        "pipx" if same("pipx") => {
            let mut plan = Plan::new(exe, &["uninstall", package]);
            plan.env = vec![
                ("PIPX_HOME".into(), path_string(root)),
                ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
            ];
            plan
        }
        "cargo" if same("cargo") => Plan::new(
            exe,
            &[
                "uninstall",
                "--root",
                text(owner, "managerRoot"),
                "--package",
                package,
            ],
        ),
        "homebrew-formula" if same("brew") => Plan::new(exe, &["uninstall", "--formula", package]),
        "scoop"
            if cfg!(windows)
                && name == "scoop.ps1"
                && owner["uninstallEvidence"] == "simple-manifest" =>
        {
            let ps = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut p = Plan::new(
                &ps,
                &[
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    text(owner, "managerExecutablePath"),
                    "uninstall",
                    package,
                ],
            );
            p.env.push(("SCOOP".into(), path_string(root)));
            p
        }
        _ => return Err("The management command does not match the package source.".into()),
    };
    if src == "homebrew-formula" {
        result.env = vec![
            ("HOMEBREW_NO_AUTO_UPDATE".into(), "1".into()),
            ("HOMEBREW_NO_ANALYTICS".into(), "1".into()),
        ];
    }
    Ok(result)
}
fn file_evidence(p: &Path) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    const LIMIT: u64 = 512 * 1024 * 1024;
    let f = fs::File::open(p).map_err(|_| "The package executable is no longer accessible.")?;
    let m = f
        .metadata()
        .map_err(|_| "The package executable is no longer accessible.")?;
    if !m.is_file() || m.len() > LIMIT {
        return Err(
            "The executable could not be fingerprinted within the verification limit.".into(),
        );
    }
    let mut hash = Sha256::new();
    let copied = std::io::copy(&mut f.take(LIMIT + 1), &mut hash)
        .map_err(|_| "The executable could not be verified.")?;
    if copied != m.len() {
        return Err("The executable changed during verification.".into());
    }
    let modified = m
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos().to_string());
    Ok(json!({
        "path": normal(&real(p)),
        "size": m.len(),
        "modified": modified,
        "sha256": format!("{:x}",hash.finalize()),
    }))
}
pub(super) fn claim(s: &Value, i: &Value) -> Result<Value, String> {
    if !supported(i) {
        return Err("An exact uninstall owner is required.".into());
    }
    let mut eps = vec![];
    let mut commands = vec![];
    for endpoint in list(s, "endpoints")
        .iter()
        .filter(|e| strings(&i["endpointIds"]).any(|id| id == text(e, "id")))
    {
        eps.push(json!({"id":endpoint["id"],"path":endpoint["path"],"fingerprint":endpoint["fingerprint"]}));
    }
    for cmd in list(s, "commands")
        .iter()
        .filter(|c| c["installationId"] == i["id"])
    {
        commands.push(json!({"name":cmd["name"],"endpointIds":cmd["endpointIds"]}));
    }
    if eps.is_empty() || commands.is_empty() {
        return Err("The package commands could not be verified.".into());
    }
    let o = &i["packageIdentity"];
    eps.sort_by_key(|v| text(v, "id").to_owned());
    commands.sort_by_key(|v| text(v, "name").to_owned());
    Ok(json!({
        "identity": o,
        "fingerprint": i["fingerprint"],
        "scope": i["scope"],
        "origin": i["origin"],
        "capability": i["uninstallCapability"],
        "endpoints": eps,
        "commands": commands,
    }))
}
pub(super) fn evidence(s: &Value, i: &Value) -> Result<Value, String> {
    let mut result = claim(s, i)?;
    let mut paths = BTreeSet::from([real(&plan(i)?.exe)]);
    for k in ["managerExecutablePath", "managerCommandPath"] {
        if let Some(p) = i["packageIdentity"][k].as_str() {
            paths.insert(real(Path::new(p)));
        }
    }
    for endpoint in list(s, "endpoints")
        .iter()
        .filter(|e| strings(&i["endpointIds"]).any(|id| id == text(e, "id")))
    {
        for key in ["path", "shimTarget", "symlinkTarget"] {
            if let Some(p) = endpoint[key].as_str() {
                paths.insert(real(Path::new(p)));
            }
        }
    }
    let files = paths
        .iter()
        .map(|p| file_evidence(p))
        .collect::<Result<Vec<_>, _>>()?;
    result["files"] = json!(files);
    Ok(result)
}
pub(super) fn execute(
    s: &Value,
    i: &Value,
    expected: &Value,
    run: impl FnOnce(&Plan) -> Result<String, String>,
) -> Result<bool, String> {
    check_same(expected, &evidence(s, i)?)?;
    Ok(run(&plan(i)?).is_ok())
}
pub(super) fn check_same(a: &Value, b: &Value) -> Result<(), String> {
    if a == b {
        Ok(())
    } else {
        Err("The installation changed. Scan again before uninstalling.".into())
    }
}
pub(super) fn preview(s: &Value, i: &Value, token: &str, expires: u64) -> Value {
    let p = find(s, "products", &i["productId"]);
    let cap = &i["uninstallCapability"];
    json!({
        "token": token,
        "expiresAt": expires,
        "inventoryRevision": s["revision"],
        "installationId": i["id"],
        "productName": p.map(|p|&p["displayName"]),
        "version": i["version"],
        "source": cap["source"],
        "packageId": cap["packageId"],
        "scope": i["scope"],
        "providedCommands": cap["providedCommands"],
        "remainingInstallationCount": p.map_or(0,|p|list(p,"currentInstallationIds").len().saturating_sub(1)),
        "support": cap["status"],
        "requiresElevation": false,
        "warnings": cap["warnings"],
    })
}
pub(super) fn consume(
    tickets: &mut BTreeMap<String, Ticket>,
    request: &Value,
) -> Result<Ticket, String> {
    if request["confirmation"] != "uninstall-exact-cli-installation" {
        return Err("CLI uninstall confirmation is invalid.".into());
    }
    let ticket = tickets
        .remove(key_id(&request["previewToken"])?)
        .ok_or("This uninstall preview has expired.")?;
    if ticket.expires <= now()
        || request["installationId"] != ticket.installation
        || request["inventoryRevision"] != ticket.revision
    {
        return Err("This uninstall preview is no longer valid.".into());
    }
    Ok(ticket)
}
