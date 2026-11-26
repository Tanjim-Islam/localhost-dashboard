use super::{model::*, runner::Plan};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
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
        "pipx" if same("pipx") => Plan::new(exe, &["uninstall", package]),
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
            Plan::new(
                &ps,
                &[
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    text(owner, "managerExecutablePath"),
                    "uninstall",
                    package,
                ],
            )
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
    let m = fs::metadata(p).map_err(|_| "The package executable is no longer accessible.")?;
    let modified = m
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos().to_string());
    Ok(json!({"path":normal(&real(p)),"size":m.len(),"modified":modified}))
}
pub(super) fn evidence(s: &Value, i: &Value, fixture: bool) -> Result<Value, String> {
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
    let mut managers = vec![];
    if !fixture {
        let p = plan(i)?;
        managers.push(file_evidence(&p.exe)?);
        for k in ["managerExecutablePath", "managerCommandPath"] {
            if let Some(s) = o[k].as_str() {
                managers.push(file_evidence(Path::new(s))?);
            }
        }
    }
    eps.sort_by_key(|v| text(v, "id").to_owned());
    commands.sort_by_key(|v| text(v, "name").to_owned());
    Ok(
        json!({"identity":o,"fingerprint":i["fingerprint"],"scope":i["scope"],"origin":i["origin"],"capability":i["uninstallCapability"],"endpoints":eps,"commands":commands,"managers":managers}),
    )
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
    json!({"token":token,"expiresAt":expires,"inventoryRevision":s["revision"],"installationId":i["id"],"productName":p.map(|p|&p["displayName"]),"version":i["version"],"source":cap["source"],"packageId":cap["packageId"],"scope":i["scope"],"providedCommands":cap["providedCommands"],"remainingInstallationCount":p.map_or(0,|p|list(p,"currentInstallationIds").len().saturating_sub(1)),"support":cap["status"],"requiresElevation":false,"warnings":cap["warnings"]})
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
