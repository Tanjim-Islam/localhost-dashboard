mod classify;
mod control;
mod health;
mod launch;
mod native;
#[cfg(any(target_os = "macos", test))]
mod npm;
mod project;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

use native::{Identity, Listener, Result, Table};
use project::{Model, Record, Reference};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::Pid;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn iso(ms: u64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms.try_into().ok()?)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "The server state is unavailable.".into())
}
#[derive(Clone)]
struct Row {
    record: Record,
    identity: Option<Identity>,
    association_key: String,
    discovery: &'static str,
    public: Value,
    ipv6: bool,
}
struct Core {
    model: Model,
    stats: HashMap<String, u64>,
    live: HashMap<String, Row>,
    missing: HashMap<String, u8>,
    recipes: HashMap<Reference, launch::Recipe>,
    allowed: HashMap<u32, Identity>,
    health: HashMap<Reference, Value>,
    progress: Value,
    revision: u64,
    last_flush: Instant,
    dirty: bool,
}
impl Core {
    fn items(&self) -> Vec<Value> {
        let mut sorted: Vec<_> = self.live.values().collect();
        sorted.sort_by_key(|row| (row.record.port, row.record.pid));
        sorted.into_iter().map(|r| r.public.clone()).collect()
    }
    fn snapshot(&self) -> Value {
        let stopped: Vec<_> = self
            .model
            .recently_stopped
            .iter()
            .map(|record| {
                let mut out = json!(record);
                let running = record.service_id.is_some()
                    && self
                        .live
                        .values()
                        .any(|r| r.record.service_id == record.service_id);
                out["canStart"] = json!(
                    self.recipes.contains_key(&record.reference)
                        && !self.ignored(record)
                        && !running
                );
                out
            })
            .collect();
        json!({"projects":self.model.projects,"recentlyStopped":stopped,"activity":self.model.activity,"legacyNotes":self.model.legacy_notes})
    }
    fn ignored(&self, r: &Record) -> bool {
        self.model
            .project(r.project_id.as_deref())
            .is_some_and(|p| p.ignored)
    }
    fn row(&self, r: &Reference) -> Result<&Row> {
        self.live
            .get(&r.key)
            .filter(|row| &row.record.reference == r)
            .ok_or_else(|| "The selected service changed. Refresh and select it again.".into())
    }
    fn reconcile(&mut self) {
        let mut records: Vec<_> = self
            .live
            .values()
            .filter(|r| r.discovery == "development")
            .map(|r| r.record.clone())
            .collect();
        records.sort_by_key(|r| (r.port, r.pid));
        records.truncate(512);
        self.model.reconcile(records, &self.live, now());
        self.recipes.retain(|r, _| {
            self.live
                .get(&r.key)
                .is_some_and(|row| row.record.reference == *r)
                || self
                    .model
                    .recently_stopped
                    .iter()
                    .any(|rec| rec.reference == *r)
        });
        self.health.retain(|r, _| {
            self.live
                .get(&r.key)
                .is_some_and(|row| row.record.reference == *r && row.public["ignored"] != true)
        });
        self.dirty = true;
    }
    fn retire(&mut self, refs: &[Reference]) {
        for r in refs {
            if self.row(r).is_ok() {
                self.live.remove(&r.key);
                self.missing.remove(&r.key);
            }
        }
        self.revision += 1;
        self.reconcile();
    }
}
pub struct Servers {
    dir: PathBuf,
    core: Mutex<Core>,
    scan: Mutex<Scanner>,
    operation: Mutex<()>,
}
struct Scanner {
    table: Table,
    cache: HashMap<u32, Cached>,
    names: HashMap<u32, Vec<String>>,
    names_at: Option<Instant>,
}
struct Cached {
    identity: Identity,
    details: classify::Classification,
    cwd: Option<PathBuf>,
    association: Option<String>,
    recipe: Option<launch::Recipe>,
    ports: BTreeSet<u16>,
    at: Instant,
}
impl Servers {
    pub fn new(dir: &Path) -> Result<Servers> {
        let model = Model::load(dir)?;
        let stats = crate::storage::read_json(dir, "stats.json", json!({"portCounts":{}}))?;
        let stats = serde_json::from_value(stats["portCounts"].clone())
            .map_err(|_| "Could not read saved port statistics.")?;
        Ok(Servers {
            dir: dir.into(),
            core: Mutex::new(Core {
                model,
                stats,
                live: HashMap::new(),
                missing: HashMap::new(),
                recipes: HashMap::new(),
                allowed: HashMap::new(),
                health: HashMap::new(),
                progress: Value::Null,
                revision: 0,
                last_flush: Instant::now(),
                dirty: true,
            }),
            scan: Mutex::new(Scanner {
                table: Table::default(),
                cache: HashMap::new(),
                names: HashMap::new(),
                names_at: None,
            }),
            operation: Mutex::new(()),
        })
    }
}
fn save(dir: &Path, core: &mut Core) -> Result<()> {
    if core.dirty {
        crate::storage::write_json(dir, "projects.json", &json!({"state":core.model}))?;
        crate::storage::write_json(dir, "stats.json", &json!({"portCounts":core.stats}))?;
        core.dirty = false;
        core.last_flush = Instant::now();
    }
    Ok(())
}
pub fn flush(app: &AppHandle) {
    if let Some(servers) = app.try_state::<Servers>() {
        if let Ok(mut c) = servers.core.lock() {
            let _ = save(&servers.dir, &mut c);
        }
    }
}
fn publish(app: &AppHandle, c: &Core) {
    let _ = app.emit("onScanUpdate", c.items());
    let _ = app.emit("onProjectsUpdate", c.snapshot());
    let _ = app.emit("onStatsUpdate", json!({"portCounts":c.stats}));
}
fn notify(app: &AppHandle, enabled: bool, title: &str, r: &Row) {
    if enabled && r.discovery == "development" && r.public["ignored"] != true {
        let name = r.record.process_name.as_deref().unwrap_or("Process");
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(format!("{name} on :{}", r.record.port))
            .show();
    }
}
fn scan(app: Option<&AppHandle>, servers: &Servers) -> Result<()> {
    let mut scanner = lock(&servers.scan)?;
    let (rev, allowed) = {
        let c = lock(&servers.core)?;
        (c.revision, c.allowed.clone())
    };
    let mut listeners = native::listeners()?;
    listeners.sort_by_key(|l| (l.pid, l.port, l.ipv6));
    listeners.dedup_by_key(|l| (l.pid, l.port));
    let mut by_pid: HashMap<u32, BTreeSet<u16>> = HashMap::new();
    for l in &listeners {
        by_pid.entry(l.pid).or_default().insert(l.port);
    }
    let Scanner {
        table,
        cache,
        names,
        names_at,
    } = &mut *scanner;
    table.refresh();
    let pids: Vec<_> = by_pid.keys().map(|&p| Pid::from_u32(p)).collect();
    table.details(&pids);
    if names_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
        *names = native::service_names();
        *names_at = Some(Instant::now());
    }
    cache.retain(|pid, _| by_pid.contains_key(pid));
    let mut budget = 12;
    let mut identities = HashMap::new();
    let mut candidates: Vec<_> = by_pid.keys().copied().collect();
    candidates.sort_by_key(|pid| (!allowed.contains_key(pid), cache.contains_key(pid), *pid));
    for pid in candidates {
        let Some(id) = native::identity(pid) else {
            cache.remove(&pid);
            continue;
        };
        let stale = cache.get(&pid).is_none_or(|c| {
            c.identity != id || c.at.elapsed() >= Duration::from_secs(60) || c.ports != by_pid[&pid]
        });
        if stale && budget > 0 && !classify::system_process(&id) {
            budget -= 1;
            if let Some(p) = table.process(pid) {
                let stage = classify::classify(
                    table,
                    Some(&id),
                    &p.name().to_string_lossy(),
                    p.cwd(),
                    p.cmd(),
                );
                let association = p
                    .cwd()
                    .map(|cwd| project::association(cwd, &id.exe, p.cmd()));
                let cwd = p.cwd().map(Path::to_owned);
                let recipe = if stage.discovery == "development" {
                    launch::plan(table, &id, &listeners, &allowed)
                        .ok()
                        .map(|p| p.recipe)
                } else {
                    None
                };
                if native::identity(pid).as_ref() == Some(&id) {
                    cache.insert(
                        pid,
                        Cached {
                            identity: id.clone(),
                            details: stage,
                            cwd,
                            association,
                            recipe,
                            ports: by_pid[&pid].clone(),
                            at: Instant::now(),
                        },
                    );
                }
            }
        }
        identities.insert(pid, id);
    }
    // A fast disappearance check or a verified operation may have retired this generation during inspection.
    let mut c = lock(&servers.core)?;
    if c.revision != rev {
        return Ok(());
    }
    let ts = now();
    let settings = app.map(crate::settings::snapshot).unwrap_or(Value::Null);
    let mut live = std::mem::take(&mut c.live);
    for Listener { pid, port, ipv6 } in listeners {
        let key = format!("{pid}:{port}");
        let previous = live.get(&key);
        let id = identities.get(&pid);
        let metadata = cache
            .get(&pid)
            .filter(|cached| Some(&cached.identity) == id);
        let started = id.and_then(|i| iso(i.unix_ms));
        let saved = c
            .model
            .last_observed
            .iter()
            .find(|r| r.reference.key == key && started.is_some() && r.process_started == started)
            .cloned();
        let same =
            previous.filter(|r| r.identity.as_ref() == id || r.identity.is_none() || id.is_none());
        let reference = Reference {
            key: key.clone(),
            first_seen: same
                .map(|r| r.record.reference.first_seen)
                .or_else(|| saved.as_ref().map(|r| r.reference.first_seen))
                .unwrap_or(ts),
        };
        let process = table.process(pid);
        let name = process
            .map(|p| p.name().to_string_lossy().into_owned())
            .or_else(|| id.map(|i| classify::basename(&i.exe)));
        let fallback = || classify::classify(table, id, name.as_deref().unwrap_or(""), None, &[]);
        let fallback_class;
        let classification = if let Some(cached) = metadata {
            &cached.details
        } else {
            fallback_class = fallback();
            &fallback_class
        };
        let mut discovery = classification.discovery;
        let private_key = metadata
            .and_then(|v| v.association.clone())
            .unwrap_or_else(|| project::hash(&format!("instance:{key}:{}", reference.first_seen)));
        let (project, association) = if discovery != "application" {
            c.model
                .assign(classification.evidence.as_ref(), &private_key, ts)
        } else {
            (None, String::new())
        };
        if project.is_some() {
            discovery = "development"
        }
        let service_names = names.get(&pid).filter(|_| discovery == "unidentified");
        let service_name = service_names
            .and_then(|s| s.first())
            .cloned()
            .unwrap_or_else(|| classification.service.clone());
        let project_id = project.as_ref().map(|p| p.id.clone());
        let service_id = (discovery != "application").then(|| {
            project::hash(&format!(
                "{}:{private_key}",
                project_id.as_deref().unwrap_or("unassigned")
            ))
        });
        let status = same
            .map(|r| r.record.status.as_str())
            .or_else(|| saved.as_ref().map(|r| r.status.as_str()))
            .unwrap_or("listening")
            .into();
        let record = Record {
            reference: reference.clone(),
            pid,
            port,
            service_name,
            last_seen: ts,
            status,
            process_name: name,
            process_started: started
                .or_else(|| same.and_then(|r| r.record.process_started.clone())),
            project_id,
            project_name: project.as_ref().map(|p| p.name.clone()),
            directory: project.as_ref().map(|p| p.directory.clone()),
            service_id,
            framework: classification.framework.clone(),
            last_status: None,
            stopped_at: None,
        };
        let mut public = json!(record);
        for key in ["status", "directory", "projectName"] {
            public.as_object_mut().unwrap().remove(key);
        }
        public["protocol"] = json!("tcp");
        public["url"] = json!(format!(
            "http://{}:{port}",
            if ipv6 { "[::1]" } else { "localhost" }
        ));
        public["discovery"] = json!(discovery);
        public["canStop"] = json!(
            cfg!(any(windows, target_os = "macos"))
                && id.is_some_and(|i| !launch::protected(table, i, &allowed))
                && classification.discovery != "unidentified"
        );
        if let Some(p) = project {
            public["association"] = json!(association);
            public["ignored"] = json!(p.ignored)
        }
        if let Some(owner) = &classification.app {
            public["application"] = owner.clone()
        }
        if let Some(cwd) = metadata.and_then(|c| c.cwd.as_ref()) {
            public["cwd"] = json!(project::display(cwd))
        }
        if let Some(names) = service_names {
            public["windowsServices"] = json!(names)
        }
        if let Some(old) = same.filter(|row| row.ipv6 == ipv6 && row.discovery == discovery) {
            if let Some(answer) = old.public.get("answersHttp") {
                public["answersHttp"] = answer.clone()
            }
        }
        if let Some(p) = process {
            public["cpu"] = json!(p.cpu_usage());
            public["memory"] = json!(p.memory());
            for (history, metric) in [("cpuHistory", "cpu"), ("memoryHistory", "memory")] {
                let mut list = same
                    .and_then(|r| r.public[history].as_array().cloned())
                    .unwrap_or_default();
                if discovery == "development" {
                    list.push(public[metric].clone());
                    if list.len() > 6 {
                        list.remove(0);
                    }
                }
                public[history] = json!(list);
            }
        }
        let new = same.is_none() && saved.is_none();
        let row = Row {
            record,
            identity: id.cloned(),
            association_key: private_key,
            discovery,
            public,
            ipv6,
        };
        if new && discovery == "development" {
            *c.stats.entry(port.to_string()).or_default() += 1;
            if let Some(app) = app {
                notify(
                    app,
                    settings["notifyOnStart"] == true,
                    "New local server",
                    &row,
                )
            }
        }
        if let Some(recipe) = metadata.and_then(|c| c.recipe.as_ref()) {
            if discovery == "development" {
                c.recipes.insert(reference, recipe.clone());
            }
        }
        c.missing.remove(&key);
        live.insert(key, row);
    }
    c.live = live;
    c.reconcile();
    if c.last_flush.elapsed() >= Duration::from_secs(30) {
        save(&servers.dir, &mut c)?
    }
    if let Some(app) = app {
        publish(app, &c)
    }
    Ok(())
}
fn presence(app: &AppHandle) -> Result<()> {
    let s = app.state::<Servers>();
    let observed: Vec<_> = lock(&s.core)?
        .live
        .values()
        .map(|r| r.record.reference.clone())
        .collect();
    let keys: HashSet<_> = native::listeners()?
        .into_iter()
        .map(|l| format!("{}:{}", l.pid, l.port))
        .collect();
    let mut c = lock(&s.core)?;
    let mut removed = Vec::new();
    let settings = crate::settings::snapshot(app);
    for r in observed {
        if c.row(&r).is_err() {
            continue;
        }
        if keys.contains(&r.key) {
            c.missing.remove(&r.key);
            continue;
        }
        let n = c.missing.entry(r.key.clone()).or_default();
        *n += 1;
        if *n >= 2 {
            notify(
                app,
                settings["notifyOnStop"] == true,
                "Listener disappeared",
                c.row(&r)?,
            );
            removed.push(r)
        }
    }
    if !removed.is_empty() {
        c.retire(&removed);
        publish(app, &c)
    }
    Ok(())
}
fn health_cycle(app: &AppHandle) -> Result<()> {
    let s = app.state::<Servers>();
    let targets: Vec<_> = lock(&s.core)?
        .live
        .values()
        .filter(|r| {
            r.public["ignored"] != true
                && (r.discovery != "unidentified" || r.public["answersHttp"].is_null())
        })
        .map(|r| health::Target {
            reference: r.record.reference.clone(),
            url: r.public["url"].as_str().unwrap_or("").into(),
            port: r.record.port,
            ipv6: r.ipv6,
            unknown: r.discovery == "unidentified",
        })
        .collect();
    if targets.is_empty() {
        return Ok(());
    }
    let jobs = Mutex::new(targets.into_iter());
    thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| loop {
                let target = jobs.lock().unwrap().next();
                let Some(t) = target else { break };
                let (value, answer) = health::probe(&t);
                let Ok(mut c) = s.core.lock() else { break };
                let Ok(r) = c.row(&t.reference) else { continue };
                if r.public["url"] != t.url || r.public["ignored"] == true {
                    continue;
                }
                let mut record = r.record.clone();
                if t.unknown {
                    if let Some(a) = answer {
                        c.live.get_mut(&t.reference.key).unwrap().public["answersHttp"] = json!(a);
                    }
                } else {
                    let down = value["status"] == "down";
                    let was_down = record.status == "http-unresponsive";
                    record.status = if down {
                        "http-unresponsive"
                    } else {
                        "listening"
                    }
                    .into();
                    if down != was_down {
                        c.live.get_mut(&t.reference.key).unwrap().record.status =
                            record.status.clone();
                        if let Some(r) = c
                            .model
                            .last_observed
                            .iter_mut()
                            .find(|r| r.reference == t.reference)
                        {
                            r.status = record.status.clone();
                        }
                        c.model.event(
                            if down {
                                "http-unresponsive"
                            } else {
                                "http-recovered"
                            },
                            record,
                            now(),
                        );
                        c.dirty = true;
                    }
                    c.health.insert(t.reference, value);
                }
            });
        }
    });
    let c = lock(&s.core)?;
    let _ = app.emit("onHealthUpdate", c.health.values().collect::<Vec<_>>());
    publish(app, &c);
    Ok(())
}
pub fn start(app: AppHandle) {
    let poll = |app: AppHandle, task: fn(&AppHandle) -> Result<()>, interval: u64| {
        thread::spawn(move || loop {
            if let Err(msg) = task(&app) {
                let _ = app.emit("onScanError", msg);
            }
            let delay = if interval == 0 {
                crate::settings::snapshot(&app)["scanIntervalMs"]
                    .as_u64()
                    .unwrap_or(5000)
                    .clamp(2000, 3600000)
            } else {
                interval
            };
            thread::sleep(Duration::from_millis(delay));
        });
    };
    poll(app.clone(), |a| scan(Some(a), &a.state::<Servers>()), 0);
    poll(app.clone(), presence, 1000);
    poll(app, health_cycle, 5000);
}
pub async fn dispatch(app: AppHandle, method: &str, arg: Value) -> Result<Value> {
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<Servers>();
        match method.as_str() {
            "getServers" => Ok(json!(lock(&s.core)?.items())),
            "getProjects" => Ok(lock(&s.core)?.snapshot()),
            "getStats" => Ok(json!({"portCounts":lock(&s.core)?.stats})),
            "getServerRestartState" => Ok(lock(&s.core)?.progress.clone()),
            "refresh" => {
                scan(Some(&app), &s)?;
                Ok(Value::Null)
            }
            "editProject" | "associateService" | "attachLegacyNote" => {
                control::edit(&app, &s, &method, arg)
            }
            "stopServers" | "startServers" | "restartServer" => {
                control::operate(Some(&app), &s, &method, arg)
            }
            "openProjectFolder" | "openTerminal" | "openInVSCode" | "openUrl" => {
                control::open(&app, &s, &method, arg)
            }
            _ => Err("Unknown server action.".into()),
        }
    })
    .await
    .map_err(|_| "The server action failed.".to_string())?
}
