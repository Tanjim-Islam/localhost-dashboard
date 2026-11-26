mod actions;
mod changes;
mod discovery;
mod fixture;
mod inventory;
mod migration;
mod model;
mod packages;
mod runner;
#[cfg(windows)]
mod windows;

use crate::storage::{read_json, write_json};
use actions::Ticket;
use model::*;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct State {
    store: Value,
    session: Value,
    cancel: Option<Arc<AtomicBool>>,
    busy: bool,
    tickets: BTreeMap<String, Ticket>,
    removed: BTreeSet<String>,
}
pub struct Clis {
    dir: PathBuf,
    fixture: Option<PathBuf>,
    state: Mutex<State>,
}
type Events<'a> = dyn Fn(&str, &Value) + Sync + 'a;
impl Clis {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        Self::open(
            data_dir,
            std::env::var_os("LOCAL_DASHBOARD_CLIS_TEST_ROOT").map(PathBuf::from),
        )
    }
    fn open(dir: &Path, fixture: Option<PathBuf>) -> Result<Self, String> {
        let raw = read_json(dir, "clis.json", empty())?;
        let mut store = migrate(&raw)?;
        let mut state = "idle";
        if matches!(text(&store, "lastScanStatus"), "scanning" | "cancelling") {
            store["lastScanStatus"] = json!("failed");
            write_json(dir, "clis.json", &store)?;
            state = "failed";
        }
        let session = json!({"id":"scan-idle","status":state,"startedAt":0,"completedSources":0,"totalSources":0,"completedProbes":0,"totalProbes":0});
        Ok(Self {
            dir: dir.into(),
            fixture,
            state: Mutex::new(State {
                store,
                session,
                cancel: None,
                busy: false,
                tickets: BTreeMap::new(),
                removed: BTreeSet::new(),
            }),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>, String> {
        self.state
            .lock()
            .map_err(|_| "CLI inventory state unavailable.".into())
    }
    fn persist(&self, state: &mut State, next: Value) -> Result<(), String> {
        write_json(&self.dir, "clis.json", &next)?;
        state.store = next;
        Ok(())
    }
    fn scan(
        &self,
        previous: &Value,
        cancel: &AtomicBool,
        force: Option<&str>,
        progress: &inventory::Progress,
    ) -> Result<Value, String> {
        if let Some(root) = &self.fixture {
            let removed = self.lock()?.removed.clone();
            return fixture::scan(root, &removed, previous, cancel, progress);
        }
        let scratch = self.dir.join("cli-neutral");
        fs::create_dir_all(&scratch).map_err(|_| "Cannot initialize the CLI working directory.")?;
        if !scratch.join("package.json").is_file() {
            fs::write(scratch.join("package.json"), b"{\"private\":true}\n")
                .map_err(|_| "Cannot initialize CLI package context.")?;
        }
        let env = discovery::Environment::capture(&scratch, dirs(&self.lock()?.store));
        inventory::scan(&env, previous, cancel, force, progress)
    }
    fn begin(&self) -> Result<Value, String> {
        let mut state = self.lock()?;
        if state.busy {
            return Err("A CLI operation is already running.".into());
        }
        let t = now();
        let mut next = state.store.clone();
        next["lastScanStartedAt"] = json!(t);
        next["lastScanStatus"] = json!("scanning");
        self.persist(&mut state, next)?;
        let session = json!({"id":uuid::Uuid::new_v4().to_string(),"status":"scanning","startedAt":t,"stage":"revalidating-cache","completedSources":0,"totalSources":0,"completedProbes":0,"totalProbes":0});
        state.cancel = Some(Arc::new(AtomicBool::new(false)));
        state.busy = true;
        state.session = session.clone();
        Ok(session)
    }
    fn publish(
        &self,
        state: &mut State,
        mut snapshot: Value,
        session: Option<&Value>,
    ) -> Result<Value, String> {
        let mut store = state.store.clone();
        let t = now();
        let complete = snapshot["completeness"] == "complete";
        if session.is_some() {
            let baseline = if store["comparisonBaseline"].is_null() {
                &store["inventory"]
            } else {
                &store["comparisonBaseline"]
            };
            let changes = changes::compare(baseline, &snapshot);
            if !changes.is_null() {
                snapshot["changes"] = changes;
            }
            if complete || store["comparisonBaseline"].is_null() {
                store["comparisonBaseline"] = snapshot.clone();
            }
        }
        if complete {
            store["lastSuccessfulScanAt"] = json!(t);
        }
        if store["lastSuccessfulScanAt"].is_number() {
            snapshot["lastSuccessfulScanAt"] = store["lastSuccessfulScanAt"].clone()
        }
        store["inventory"] = snapshot.clone();
        store["lastCompletedScanAt"] = json!(t);
        store["lastScanStatus"] = snapshot["completeness"].clone();
        if let Some(session) = session {
            prepend(
                &mut store,
                "scanAttempts",
                json!({"scanSessionId":session["id"],"startedAt":session["startedAt"],"finishedAt":t,"status":snapshot["completeness"],"sourceFailureCount":list(&snapshot,"sourceResults").iter().filter(|s|s["status"]=="failed").count()}),
                20,
            );
        }
        self.persist(state, store)?;
        state.tickets.clear();
        Ok(snapshot)
    }
    fn manual(&self, start: Value, events: &Events) -> Result<Value, String> {
        let (old, cancel) = {
            let s = self.lock()?;
            (
                s.store["inventory"].clone(),
                s.cancel.clone().ok_or("Missing scan session.")?,
            )
        };
        let progress = |stage: &str, label: &str, done: usize, total: usize| {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            let event = if let Ok(mut s) = self.lock() {
                s.session["stage"] = json!(stage);
                s.session["completedSources"] = json!(done);
                s.session["totalSources"] = json!(total);
                let mut event = s.session.clone();
                event["scanSessionId"] = start["id"].clone();
                event["label"] = json!(label);
                if stage == "checking-versions" {
                    event["completedProbes"] = json!(done);
                    event["totalProbes"] = json!(total);
                }
                event
            } else {
                return;
            };
            events("onCliScanProgress", &event)
        };
        let result = self.scan(&old, &cancel, None, &progress);
        let mut s = self.lock()?;
        let result = if cancel.load(Ordering::Acquire) {
            Err("Scan cancelled.".into())
        } else {
            result.and_then(|snapshot| self.publish(&mut s, snapshot, Some(&start)))
        };
        s.cancel = None;
        s.busy = false;
        s.session["finishedAt"] = json!(now());
        match result {
            Ok(v) => {
                s.session["status"] = v["completeness"].clone();
                drop(s);
                events("onCliInventoryChanged", &v);
                events("onCliScanComplete", &v);
                Ok(v)
            }
            Err(msg) => {
                let status = if cancel.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "failed"
                };
                s.session["status"] = json!(status);
                s.session["message"] = json!(msg);
                let mut store = s.store.clone();
                store["lastScanStatus"] = json!(status);
                store["lastCompletedScanAt"] = json!(now());
                prepend(
                    &mut store,
                    "scanAttempts",
                    json!({"scanSessionId":start["id"],"startedAt":start["startedAt"],"finishedAt":now(),"status":status,"sourceFailureCount":0,"message":msg}),
                    20,
                );
                let persisted = self.persist(&mut s, store);
                drop(s);
                events(
                    "onCliScanError",
                    &json!({"scanSessionId":start["id"],"status":status,"message":msg}),
                );
                persisted?;
                Err(msg)
            }
        }
    }
    fn action(&self, method: &str, arg: &Value, events: &Events) -> Result<Value, String> {
        let (snap, item, ticket) = {
            let mut s = self.lock()?;
            if s.busy {
                return Err("Wait for the current CLI operation to finish.".into());
            }
            let (snapshot, item) = require(&s.store, arg)?;
            let values = (snapshot.clone(), item.clone());
            let ticket = if method == "uninstallCliInstallation" {
                Some(actions::consume(&mut s.tickets, arg)?)
            } else {
                None
            };
            s.busy = true;
            (values.0, values.1, ticket)
        };
        let result = self.run_action(method, &snap, &item, ticket, events);
        self.lock()?.busy = false;
        result
    }
    fn run_action(
        &self,
        method: &str,
        previous: &Value,
        item: &Value,
        ticket: Option<Ticket>,
        events: &Events,
    ) -> Result<Value, String> {
        let cancel = AtomicBool::new(false);
        let force = (method == "verifyCliInstallation").then(|| text(item, "id"));
        let request = uuid::Uuid::new_v4().to_string();
        let started = now();
        let progress = |stage: &str, label: &str| {
            if method == "uninstallCliInstallation" {
                events(
                    "onCliUninstallProgress",
                    &json!({"requestId":request,"installationId":item["id"],"stage":stage,"label":label}),
                );
            }
        };
        progress("revalidating", "Revalidating package ownership");
        let fresh = self.scan(previous, &cancel, force, &|_, _, _, _| {})?;
        if method == "verifyCliInstallation" {
            let v = self.publish(&mut *self.lock()?, fresh, None)?;
            events("onCliInventoryChanged", &v);
            return Ok(v);
        }
        let new = find(&fresh, "installations", &item["id"])
            .ok_or("The installation is no longer present.")?;
        let fixture = self.fixture.is_some();
        let evidence = actions::evidence(&fresh, new, fixture)?;
        actions::check_same(&actions::evidence(previous, item, fixture)?, &evidence)?;
        if method == "getCliUninstallPreview" {
            let token = uuid::Uuid::new_v4().to_string();
            let expires = now() + 60000;
            let mut s = self.lock()?;
            s.tickets.retain(|_, p| p.expires > now());
            if s.tickets.len() >= 32 {
                let old = s
                    .tickets
                    .iter()
                    .min_by_key(|(_, v)| v.expires)
                    .map(|(k, _)| k.clone())
                    .unwrap();
                s.tickets.remove(&old);
            }
            s.tickets.insert(
                token.clone(),
                Ticket {
                    expires,
                    installation: text(item, "id").into(),
                    revision: text(previous, "revision").into(),
                    evidence,
                },
            );
            return Ok(actions::preview(previous, item, &token, expires));
        }
        let ticket = ticket.ok_or("Missing uninstall preview.")?;
        if now() >= ticket.expires {
            return Err("The uninstall preview expired.".into());
        }
        actions::check_same(&ticket.evidence, &evidence)?;
        progress("uninstalling", "Removing the exact package");
        let result = if fixture {
            if new["productId"] == "opencode" {
                Err("Fixture package manager rejected uninstall.".into())
            } else {
                self.lock()?.removed.insert(text(new, "id").into());
                Ok(String::new())
            }
        } else {
            let plan = actions::plan(new)?;
            runner::run(
                &plan,
                &self.dir.join("cli-neutral"),
                &cancel,
                Duration::from_secs(90),
                256 * 1024,
            )
        };
        progress("verifying", "Verifying the selected installation");
        let after = self.scan(&fresh, &cancel, None, &|_, _, _, _| {});
        let absence = fixture
            || strings(&new["endpointIds"]).all(|id| {
                find(&fresh, "endpoints", &json!(id)).is_some_and(|ep| {
                    fs::symlink_metadata(text(ep, "path"))
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                })
            });
        let removed = result.is_ok()
            && absence
            && after.as_ref().is_ok_and(|s| {
                find(s, "installations", &new["id"]).is_none()
                    && !list(s, "sourceResults").iter().any(|r| {
                        r["status"] == "failed"
                            && text(r, "sourceId").split('|').next()
                                == new["packageIdentity"]["source"].as_str()
                    })
            });
        progress("refreshing", "Refreshing inventory");
        let (status, message) = if result.is_err() {
            (
                "failed",
                "The package manager could not remove the selected package.",
            )
        } else if removed {
            (
                "succeeded",
                "The exact installation was removed and the inventory was refreshed.",
            )
        } else {
            (
                "verification-failed",
                "The command finished, but removal could not be verified.",
            )
        };
        let mut s = self.lock()?;
        let published = match after {
            Ok(snapshot) => Some(self.publish(&mut s, snapshot, None)?),
            Err(_) => None,
        };
        let summary = json!({"requestId":request,"installationId":new["id"],"status":status,"verifiedRemoved":removed,"message":message,"inventoryRevision":s.store["inventory"]["revision"]});
        let mut store = s.store.clone();
        prepend(
            &mut store,
            "uninstallAudits",
            json!({"requestId":request,"installationId":new["id"],"source":new["packageIdentity"]["source"],"packageId":new["packageIdentity"]["packageId"],"startedAt":started,"finishedAt":now(),"status":status,"message":message}),
            100,
        );
        self.persist(&mut s, store)?;
        drop(s);
        if let Some(v) = published {
            events("onCliInventoryChanged", &v)
        }
        events("onCliUninstallComplete", &summary);
        Ok(summary)
    }
    fn direct(&self, app: &AppHandle, method: &str, arg: Value) -> Result<Value, String> {
        let events = |event: &str, v: &Value| {
            let _ = app.emit_to("main", event, v);
        };
        match method {
            "getCliInventory" => {
                let mut v = self.lock()?.store["inventory"].clone();
                if v.is_object() {
                    v["cached"] = json!(true);
                }
                Ok(v)
            }
            "getCliScanDirectories" => Ok(dir_items(&self.lock()?.store)),
            "getCliScanState" => Ok(self.lock()?.session.clone()),
            "chooseCliScanDirectory" | "removeCliScanDirectory" => {
                let selected = if method == "chooseCliScanDirectory" {
                    app.dialog()
                        .file()
                        .blocking_pick_folder()
                        .map(|p| p.into_path().map_err(|_| "Invalid scan folder."))
                        .transpose()?
                } else {
                    None
                };
                let mut s = self.lock()?;
                if s.busy {
                    return Err("Wait for the current CLI operation to finish.".into());
                }
                let mut paths = dirs(&s.store);
                if let Some(p) = selected {
                    if !p.is_absolute() || !p.is_dir() || path_string(&p).len() > 1024 {
                        return Err("Invalid scan folder.".into());
                    }
                    if !paths.iter().any(|d| normal(d) == normal(&p)) {
                        if paths.len() == 20 {
                            return Err("You can add up to 20 scan folders.".into());
                        }
                        paths.push(p);
                    }
                } else if method == "removeCliScanDirectory" {
                    let key = key_id(&arg)?;
                    paths.retain(|p| id("scan-folder", json!({"path":normal(p)})) != key);
                }
                let mut store = s.store.clone();
                store["scanDirectories"] = json!(paths);
                self.persist(&mut s, store)?;
                Ok(dir_items(&s.store))
            }
            "startCliScan" => {
                let session = self.begin()?;
                let start = session.clone();
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<Clis>();
                    let _ = state.manual(start, &|ev, p| {
                        let _ = handle.emit_to("main", ev, p);
                    });
                });
                Ok(session)
            }
            "cancelCliScan" => {
                let id = key_id(&arg)?;
                let mut s = self.lock()?;
                if s.session["id"] != id {
                    return Err("The scan session changed.".into());
                }
                s.cancel
                    .as_ref()
                    .ok_or("There is no active scan.")?
                    .store(true, Ordering::Release);
                s.session["status"] = json!("cancelling");
                Ok(s.session.clone())
            }
            "revealCliInstallation" => {
                let s = self.lock()?;
                let (snap, item) = require(&s.store, &arg)?;
                let path = list(snap, "endpoints")
                    .iter()
                    .find(|e| {
                        strings(&item["endpointIds"]).any(|k| k == text(e, "id"))
                            && Path::new(text(e, "path")).is_file()
                    })
                    .ok_or("The CLI installation could not be found.")?;
                app.opener()
                    .reveal_item_in_dir(text(path, "path"))
                    .map_err(|_| "Unable to reveal this installation.")?;
                Ok(Value::Null)
            }
            "setCliInstallationIncluded" => {
                let mut s = self.lock()?;
                if s.busy {
                    return Err("Wait for the scan to finish.".into());
                }
                let (original, item) = require(&s.store, &arg)?;
                if !matches!(text(item, "discoveryKind"), "candidate" | "user") {
                    return Err(
                        "Only other discoveries can be added to or removed from the CLI list."
                            .into(),
                    );
                }
                let included = arg["included"]
                    .as_bool()
                    .ok_or("Invalid CLI list preference.")?;
                if included
                    && !list(original, "endpoints").iter().any(|e| {
                        strings(&item["endpointIds"]).any(|id| id == text(e, "id"))
                            && e["executable"] == true
                    })
                {
                    return Err("No runnable command endpoint is available.".into());
                }
                let mut v = original.clone();
                let row = v["installations"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|v| v["id"] == item["id"])
                    .unwrap();
                row["includedByUser"] = json!(included);
                row["discoveryKind"] = json!(if included { "user" } else { "candidate" });
                v["revision"] = json!(uuid::Uuid::new_v4().to_string());
                inventory::products(&mut v);
                let mut store = s.store.clone();
                store["inventory"] = v.clone();
                self.persist(&mut s, store)?;
                s.tickets.clear();
                drop(s);
                events("onCliInventoryChanged", &v);
                Ok(v)
            }
            "verifyCliInstallation" | "getCliUninstallPreview" | "uninstallCliInstallation" => {
                self.action(method, &arg, &events)
            }
            _ => Err("Unknown CLI request.".into()),
        }
    }
}
pub async fn dispatch(app: AppHandle, method: &str, arg: Value) -> Result<Value, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("CLI inventory is available on Windows and macOS.".into());
    }
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || app.state::<Clis>().direct(&app, &method, arg))
        .await
        .map_err(|_| "CLI operation did not complete.")?
}
fn require<'a>(store: &'a Value, arg: &Value) -> Result<(&'a Value, &'a Value), String> {
    key_id(&arg["installationId"])?;
    let revision = key_id(&arg["inventoryRevision"])?;
    let s = &store["inventory"];
    if s["revision"] != revision {
        return Err("The CLI inventory changed. Refresh and try again.".into());
    }
    Ok((
        s,
        find(s, "installations", &arg["installationId"])
            .ok_or("The CLI installation was not found.")?,
    ))
}
fn migrate(raw: &Value) -> Result<Value, String> {
    if !raw.is_object() {
        return Err("Invalid CLI store.".into());
    }
    let mut s = empty();
    for key in [
        "lastScanStatus",
        "lastScanStartedAt",
        "lastSuccessfulScanAt",
        "lastCompletedScanAt",
    ] {
        if let Some(value) = raw.get(key) {
            s[key] = value.clone();
        }
    }
    s["scanDirectories"] = json!(dirs(raw));
    for (key, bound) in [("scanAttempts", 20), ("uninstallAudits", 100)] {
        s[key] = json!(list(raw, key).iter().take(bound).collect::<Vec<_>>());
    }
    for key in ["inventory", "comparisonBaseline"] {
        let v = &raw[key];
        if v.is_null() {
            continue;
        }
        if !v["revision"].is_string()
            || ![
                "products",
                "installations",
                "commands",
                "endpoints",
                "sourceResults",
            ]
            .iter()
            .all(|k| v[*k].is_array())
        {
            continue;
        }
        if list(v, "installations").len() > 10000
            || list(v, "products").len() > 5000
            || list(v, "commands").len() > 80000
            || list(v, "endpoints").len() > 120000
        {
            continue;
        }
        s[key] = if v["schemaVersion"] == 1 {
            migration::legacy(v)
        } else {
            v.clone()
        };
    }
    if s["comparisonBaseline"].is_null() && s["inventory"]["completeness"] == "complete" {
        s["comparisonBaseline"] = s["inventory"].clone();
    }
    Ok(s)
}
#[cfg(test)]
mod scanner_tests;
#[cfg(test)]
mod tests;
