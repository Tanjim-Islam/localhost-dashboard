use super::processes::extension;
use super::{now, Record};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(super) struct Process {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub exe: PathBuf,
    pub args: Vec<PathBuf>,
    pub started: u64,
    pub cpu: f32,
    pub memory: u64,
}

fn bundle(path: &Path, ext: &str) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| extension(p) == ext)
        .map(Path::to_owned)
}

fn label(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn attach(record: &mut Record, p: &Process) {
    let item = &mut record.item;
    item["pid"] = json!(p.pid);
    item["ppid"] = json!(p.ppid);
    item["processName"] = json!(if label(&p.exe) == "swift-frontend" {
        "swift".into()
    } else {
        label(&p.exe)
    });
    item["processPath"] = json!(p.exe);
    item["runtimeSeconds"] = json!((now() / 1000).saturating_sub(p.started));
    item["firstSeen"] = json!(p.started.saturating_mul(1000));
    item["status"] = json!("running");
    item["cpu"] = json!(p.cpu);
    item["memory"] = json!(p.memory);
    record.native_id = Some(p.started);
    record.executable = Some(p.exe.clone());
}

fn detect(p: &Process) -> Option<(Option<PathBuf>, &'static str, &'static str)> {
    let exe = p.exe.to_string_lossy();
    if exe.contains("ShortcutsViewService") {
        return None;
    }
    if exe.ends_with("WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner") {
        return Some((None, "workflow-service-runner", "Workflow service runner"));
    }
    if exe.ends_with("com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner") {
        return Some((None, "automator-runner", "Automator runner"));
    }
    if exe.ends_with(".app/Contents/MacOS/Application Stub") {
        return Some((
            Some(bundle(&p.exe, "app")?),
            "automator-app",
            "Automator app",
        ));
    }
    let path = p.args.iter().find(|s| {
        s.is_absolute() && matches!(extension(s).as_str(), "workflow" | "scpt" | "applescript")
    })?;
    match (label(&p.exe).as_str(), extension(path).as_str()) {
        ("osascript", _) => Some((Some(path.clone()), "osascript", "AppleScript")),
        (_, "workflow") => Some((Some(path.clone()), "workflow", "Automator workflow")),
        _ => None,
    }
}

pub(super) fn discover(dir: &Path, processes: &[Process]) -> Result<Vec<Record>, String> {
    let time = now();
    let mut items = BTreeMap::<PathBuf, Record>::new();
    let mut anonymous = Vec::new();
    let directory = match std::fs::read_dir(dir) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Could not read the Services folder.".into()),
    };
    for entry in directory.into_iter().flatten() {
        let path = entry.map_err(|_| "Could not read Services entry.")?.path();
        let ext = extension(&path);
        if label(&path).starts_with('.')
            || !matches!(
                ext.as_str(),
                "workflow"
                    | "app"
                    | "scpt"
                    | "applescript"
                    | "swift"
                    | "sh"
                    | "command"
                    | "js"
                    | "ts"
                    | "py"
                    | "rb"
                    | "pl"
            )
        {
            continue;
        }
        let workflow = matches!(ext.as_str(), "workflow" | "app");
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if !(metadata.is_file() || workflow && metadata.is_dir()) {
            continue;
        }
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let name = stem.strip_prefix("~:").unwrap_or(&stem);
        let created = metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(time, |d| d.as_millis() as u64);
        let mut record = Record::new(json!({"key":path,"scriptPath":path,"scriptName":name,
            "sourceKind": if workflow {"service-workflow"} else {"service-script"},
            "sourceLabel": if workflow {"Automator workflow"} else {"Services script"},
            "status":"installed","firstSeen":created,"lastSeen":time,"canOpenInAutomator":workflow}));
        if let Some(p) = processes
            .iter()
            .find(|p| p.args.contains(&path) || p.exe.starts_with(&path))
        {
            attach(&mut record, p);
        }
        items.insert(path, record);
    }
    for p in processes {
        let Some((path, kind, source)) = detect(p) else {
            continue;
        };
        let Some(path) = path else {
            anonymous.push(p);
            continue;
        };
        if path.starts_with(dir) {
            continue;
        }
        let mut row = Record::new(
            json!({"key":path,"scriptPath":path,"scriptName":label(&path),
            "sourceKind":kind,"sourceLabel":source,"lastSeen":time,
            "canOpenInAutomator":matches!(extension(&path).as_str(),"workflow"|"app")}),
        );
        attach(&mut row, p);
        items.insert(path, row);
    }
    let mut unmatched: Vec<_> = items
        .values_mut()
        .filter(|r| r.item["sourceKind"] == "service-workflow" && r.item["pid"].is_null())
        .collect();
    if unmatched.len() == anonymous.len() {
        unmatched.sort_by_key(|r| r.item["scriptName"].as_str().unwrap_or("").to_lowercase());
        anonymous.sort_by_key(|p| p.pid);
        for (record, p) in unmatched.into_iter().zip(anonymous) {
            attach(record, p);
            record.item["processPath"] = bundle(&p.exe, "xpc").map_or(Value::Null, |p| json!(p));
        }
    }
    Ok(items.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(pid: u32, exe: &str) -> Process {
        Process {
            pid,
            ppid: Some(1),
            exe: exe.into(),
            args: vec![],
            started: 1700000000,
            cpu: 1.0,
            memory: 1200,
        }
    }
    #[test]
    fn identifies_script_runner_and_bundle_from_native_arguments() {
        let runner = p(
            10,
            "/System/WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner",
        );
        assert_eq!(detect(&runner).unwrap().1, "workflow-service-runner");
        let mut app = p(
            11,
            "/Users/me/Automation/Nightly Build.app/Contents/MacOS/Application Stub",
        );
        assert_eq!(
            detect(&app).unwrap().0.unwrap(),
            Path::new("/Users/me/Automation/Nightly Build.app")
        );
        app.exe = "/System/ShortcutsViewService".into();
        assert!(detect(&app).is_none());
        let dir = tempfile::tempdir().unwrap();
        let mut osa = p(12, "/usr/bin/osascript");
        osa.args.push(dir.path().join("Sync Mail.scpt"));
        assert_eq!(detect(&osa).unwrap().1, "osascript");
    }

    #[test]
    fn services_keep_script_names_and_exact_runner_matching() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["alpha.workflow", "beta.workflow"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let swift = dir.path().join("keepalive.swift");
        std::fs::write(&swift, "// fixture").unwrap();
        let mut swift_process = p(3, "/bin/swift-frontend");
        swift_process.args.push(swift);
        let first = p(
            4,
            "/System/WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner",
        );
        let mut rows = vec![swift_process, first];
        let installed = discover(dir.path(), &rows).unwrap();
        assert_eq!(
            installed
                .iter()
                .filter(|r| r.item["status"] == "installed")
                .count(),
            2
        );
        rows.push(p(
            5,
            "/System/com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner",
        ));
        let matched = discover(dir.path(), &rows).unwrap();
        assert_eq!(matched.len(), 3);
        assert!(matched.iter().all(|r| r.item["status"] == "running"));
        assert_eq!(
            matched
                .iter()
                .find(|r| r.item["scriptName"] == "alpha")
                .unwrap()
                .item["pid"],
            4
        );
        assert_eq!(
            matched
                .iter()
                .find(|r| r.item["scriptName"] == "keepalive")
                .unwrap()
                .item["processName"],
            "swift"
        );
    }
}
