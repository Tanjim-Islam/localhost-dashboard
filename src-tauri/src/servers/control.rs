use super::*;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
#[cfg(not(windows))]
use std::process::Command;
use tauri_plugin_opener::OpenerExt;

fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| "Invalid service request.".into())
}
fn text(value: &str, max: usize) -> Result<String> {
    if value.encode_utf16().count() > max
        || value.chars().any(|c| c < ' ' && !matches!(c, '\n' | '\t'))
    {
        return Err("Invalid project text.".into());
    }
    Ok(value.trim().into())
}
#[derive(Deserialize)]
struct Edit {
    id: String,
    name: String,
    notes: String,
    pinned: bool,
    bookmarked: bool,
    ignored: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Association {
    #[serde(rename = "ref")]
    reference: Reference,
    project_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    note_id: String,
    project_id: String,
}
pub(super) fn edit(
    app: Option<&AppHandle>,
    s: &Servers,
    method: &str,
    arg: Value,
) -> Result<Value> {
    {
        let mut c = lock(&s.core)?;
        match method {
            "editProject" => {
                let e: Edit = parse(arg)?;
                let name = text(&e.name, 120)?;
                let notes = text(&e.notes, 4000)?;
                if name.is_empty() {
                    return Err("A project name is required.".into());
                }
                let p = c
                    .model
                    .projects
                    .iter_mut()
                    .find(|p| p.id == e.id)
                    .ok_or("Project no longer exists.")?;
                p.name = name;
                p.notes = notes;
                p.pinned = e.pinned;
                p.bookmarked = e.bookmarked;
                if let Some(flag) = e.ignored {
                    p.ignored = flag
                }
            }
            "associateService" => {
                if arg.get("projectId").is_none() {
                    return Err("Select a project.".into());
                }
                let e: Association = parse(arg)?;
                if !e.reference.valid() {
                    return Err("Invalid service reference.".into());
                }
                if e.project_id.is_some() && c.model.project(e.project_id.as_deref()).is_none() {
                    return Err("Project no longer exists.".into());
                }
                let row = c.row(&e.reference)?;
                if row.discovery == "application" {
                    return Err("Application services cannot be associated with projects.".into());
                }
                if row.identity.is_none() || native::identity(row.record.pid) != row.identity {
                    return Err("The service changed. Refresh and try again.".into());
                }
                let key = row.association_key.clone();
                if !c.model.associations.contains_key(&key) && c.model.associations.len() >= 2000 {
                    return Err("Association limit reached.".into());
                }
                c.model.associations.insert(key, e.project_id);
            }
            "attachLegacyNote" => {
                let e: Attachment = parse(arg)?;
                let index = c
                    .model
                    .legacy_notes
                    .iter()
                    .position(|n| n.id == e.note_id)
                    .ok_or("Note no longer exists.")?;
                let legacy = c.model.legacy_notes[index].text.clone();
                let p = c
                    .model
                    .projects
                    .iter_mut()
                    .find(|p| p.id == e.project_id)
                    .ok_or("Project no longer exists.")?;
                let notes = if p.notes.is_empty() {
                    legacy
                } else {
                    format!("{}\n{legacy}", p.notes)
                };
                if notes.encode_utf16().count() > 4000 {
                    return Err(
                        "The combined note exceeds 4000 characters. Edit the project note first."
                            .into(),
                    );
                }
                p.notes = notes;
                c.model.legacy_notes.remove(index);
            }
            _ => return Err("Unknown project action.".into()),
        }
        c.revision += 1;
        c.dirty = true;
        save(&s.dir, &mut c)?;
        if method != "associateService" {
            // A cached project edit is not an OS listener observation. Apply its
            // public fields immediately, including before the first scan.
            let Core { model, live, .. } = &mut *c;
            for row in live.values_mut() {
                if let Some(p) = model.project(row.record.project_id.as_deref()) {
                    row.public["ignored"] = json!(p.ignored);
                    row.record.project_name = Some(p.name.clone());
                }
            }
            let result = c.snapshot();
            if let Some(app) = app {
                publish(app, &c);
            }
            return Ok(result);
        }
    }
    scan(app, s)?;
    Ok(lock(&s.core)?.snapshot())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    refs: Vec<Reference>,
    project_id: Option<String>,
}
impl Scope {
    fn parse(v: Value) -> Result<Self> {
        let scope: Scope = parse(v)?;
        let unique: HashSet<_> = scope.refs.iter().map(|r| &r.key).collect();
        if scope.refs.is_empty()
            || scope.refs.len() > 100
            || unique.len() != scope.refs.len()
            || scope.refs.iter().any(|r| !r.valid())
        {
            return Err("Select between 1 and 100 distinct services.".into());
        }
        Ok(scope)
    }
}
fn eligible(c: &Core, r: &Reference, project: Option<&str>, development: bool) -> Result<Row> {
    let row = c.row(r)?;
    if c.ignored(&row.record)
        || row.public["canStop"] != true
        || (!["development", "application"].contains(&row.discovery))
        || (development && row.discovery != "development")
        || (project.is_some()
            && (row.record.project_id.as_deref() != project || row.discovery != "development"))
    {
        return Err("A selected service changed or is protected. Review the selection.".into());
    }
    if c.live
        .values()
        .any(|i| i.record.pid == row.record.pid && i.record.project_id != row.record.project_id)
    {
        return Err("This process serves more than one project.".into());
    }
    Ok(row.clone())
}
fn same_selection(c: &Core, r: &Row, scope: Option<&str>, development: bool) -> Result<()> {
    let current = eligible(c, &r.record.reference, scope, development)?;
    if current.identity != r.identity
        || r.record.project_id != current.record.project_id
        || current.discovery != r.discovery
    {
        return Err("Service identity or association changed.".into());
    }
    Ok(())
}
fn remember(c: &mut Core, ids: Vec<Identity>) {
    c.allowed
        .retain(|_, id| native::identity(id.pid).as_ref() == Some(id));
    for id in ids.into_iter().take(128) {
        if c.allowed.len() < 512 {
            c.allowed.insert(id.pid, id);
        }
    }
}
fn stop(s: &Servers, scope: &Scope, app: Option<&AppHandle>) -> Result<Value> {
    let table = {
        let mut t = Table::default();
        t.refresh();
        t
    };
    let listeners = native::listeners()?;
    let c = lock(&s.core)?;
    let mut plans = BTreeMap::new();
    for reference in &scope.refs {
        let row = eligible(&c, reference, scope.project_id.as_deref(), false)?;
        let id = row
            .identity
            .as_ref()
            .ok_or("Process identity unavailable.")?;
        if native::identity(id.pid).as_ref() != Some(id)
            || launch::protected(&table, id, &c.allowed)
        {
            return Err("A selected process is protected or changed.".into());
        }
        let ports: BTreeSet<_> = listeners
            .iter()
            .filter(|l| l.pid == id.pid)
            .map(|l| l.port)
            .collect();
        let affected: Vec<_> = c
            .live
            .values()
            .filter(|i| i.record.pid == id.pid)
            .cloned()
            .collect();
        if !ports.contains(&row.record.port)
            || affected
                .iter()
                .map(|r| r.record.port)
                .collect::<BTreeSet<_>>()
                != ports
        {
            return Err("Listener ownership changed. Refresh and review the service.".into());
        }
        for r in &affected {
            same_selection(&c, r, scope.project_id.as_deref(), false)?
        }
        let target = json!({"ref":row.record.reference,"pid":id.pid,"ports":ports,"serviceName":row.record.service_name,
            "processName":row.record.process_name.as_deref().unwrap_or("Process"),"projectName":row.record.project_name});
        plans
            .entry(id.pid)
            .or_insert((id.clone(), target, ports, affected));
    }
    drop(c);
    let mut results = Vec::new();
    for (_, (id, target, ports, affected)) in plans {
        let action = || -> Result<()> {
            let mut table = Table::default();
            table.refresh();
            let actual: BTreeSet<_> = native::listeners()?
                .into_iter()
                .filter(|l| l.pid == id.pid)
                .map(|l| l.port)
                .collect();
            let mut core = lock(&s.core)?;
            if actual != ports || launch::protected(&table, &id, &core.allowed) {
                return Err("Listener ownership changed.".into());
            }
            for r in &affected {
                same_selection(&core, r, scope.project_id.as_deref(), false)?
            }
            native::stop(&id)?;
            for _ in 0..12 {
                if native::identity(id.pid).as_ref() != Some(&id) {
                    let refs: Vec<_> = affected
                        .iter()
                        .map(|r| r.record.reference.clone())
                        .collect();
                    core.retire(&refs);
                    save(&s.dir, &mut core)?;
                    if let Some(app) = app {
                        notify_stopped(app, &affected);
                        publish(app, &core)
                    }
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(250))
            }
            Err("The process is still running.".into())
        };
        let r = action();
        results.push(json!({"target":target,"ok":r.is_ok(),"message":r.err().unwrap_or_else(||"Stopped".into())}));
    }
    Ok(json!(results))
}
fn startable(c: &Core, r: &Reference, project: Option<&str>) -> Result<(Record, launch::Recipe)> {
    let record = c
        .model
        .recently_stopped
        .iter()
        .find(|v| v.reference == *r)
        .ok_or("This stopped service is no longer available.")?;
    let recipe = c
        .recipes
        .get(r)
        .ok_or("Launch details are unavailable. Start this service from its terminal.")?;
    if c.ignored(record) || (project.is_some() && record.project_id.as_deref() != project) {
        return Err("Project association or visibility changed.".into());
    }
    if record.service_id.is_some()
        && c.live
            .values()
            .any(|row| row.record.service_id == record.service_id)
    {
        return Err("This service is already running.".into());
    }
    Ok((record.clone(), recipe.clone()))
}
fn start_stopped(s: &Servers, scope: &Scope, app: Option<&AppHandle>) -> Result<Value> {
    let mut launches: Vec<(launch::Recipe, Vec<Record>)> = Vec::new();
    {
        let c = lock(&s.core)?;
        for r in &scope.refs {
            let (record, recipe) = startable(&c, r, scope.project_id.as_deref())?;
            if let Some((_, records)) = launches
                .iter_mut()
                .find(|(p, _)| p.launch.id == recipe.launch.id)
            {
                records.push(record)
            } else {
                launches.push((recipe, vec![record]));
            }
        }
    }
    let mut occupied: HashSet<_> = native::listeners()?.iter().map(|l| l.port).collect();
    for (r, _) in &launches {
        launch::preflight(r)?;
        if native::identity(r.launch.id.pid).as_ref() == Some(&r.launch.id) {
            return Err("The original launcher is still running.".into());
        }
        for &port in &r.ports {
            if !occupied.insert(port) {
                return Err(format!(
                    "Port :{port} is already in use. Nothing was started."
                ));
            }
        }
    }
    let mut results = Vec::new();
    for (r, records) in launches {
        let result = launch::launch(&r, || {
            let c = lock(&s.core)?;
            for rec in &records {
                startable(&c, &rec.reference, scope.project_id.as_deref())?;
            }
            Ok(c)
        });
        let ok = result.is_ok();
        let message = match result {
            Ok(ids) => {
                let mut c = lock(&s.core)?;
                remember(&mut c, ids);
                let refs: HashSet<_> = records.iter().map(|r| &r.reference).collect();
                c.model
                    .recently_stopped
                    .retain(|v| !refs.contains(&v.reference));
                for rr in refs {
                    c.recipes.remove(rr);
                }
                c.dirty = true;
                c.revision += 1;
                save(&s.dir, &mut c)?;
                "Started".into()
            }
            Err(e) => e,
        };
        for rec in records {
            results.push(json!({"ref":rec.reference,"port":rec.port,"serviceName":rec.service_name,"ok":ok,"message":message}));
        }
    }
    scan(app, s)?;
    Ok(json!(results))
}
fn restart(s: &Servers, r: Reference, app: Option<&AppHandle>) -> Result<Value> {
    let (row, allowed) = {
        let c = lock(&s.core)?;
        (eligible(&c, &r, None, true)?, c.allowed.clone())
    };
    let port = row.record.port;
    let emit = |phase: &str, msg: &str| {
        let value = json!({"key":r.key,"port":port,"phase":phase,"message":msg});
        if let Ok(mut c) = s.core.lock() {
            c.progress = value.clone();
        }
        if let Some(a) = app {
            let _ = a.emit("onServerRestartProgress", value);
        }
    };
    let run = || -> Result<String> {
        emit("preparing", "Checking the original server and launcher...");
        let id = row
            .identity
            .as_ref()
            .ok_or("The server identity is unknown.")?;
        let mut t = Table::default();
        t.refresh();
        let listeners = native::listeners()?;
        if !listeners.iter().any(|l| l.pid == id.pid && l.port == port) {
            return Err("The original listener disappeared.".into());
        }
        let plan = launch::plan(&t, id, &listeners, &allowed)?;
        launch::preflight(&plan.recipe)?;
        t.refresh();
        launch::verify_plan(&plan, &t, &native::listeners()?)?;
        emit("stopping", "Stopping the server and its launcher...");
        {
            let mut c = lock(&s.core)?;
            same_selection(&c, &row, None, true)?;
            // Check all observed listeners in the tree, including ignored or protected siblings.
            let affected: Vec<_> = c
                .live
                .values()
                .filter(|i| i.identity.as_ref().is_some_and(|id| plan.tree.contains(id)))
                .cloned()
                .collect();
            for other in &affected {
                eligible(
                    &c,
                    &other.record.reference,
                    row.record.project_id.as_deref(),
                    true,
                )?;
            }
            launch::stop_tree(&plan)?;
            if let Some(app) = app {
                notify_stopped(app, &affected);
            }
            c.retire(
                &affected
                    .iter()
                    .map(|row| row.record.reference.clone())
                    .collect::<Vec<_>>(),
            );
        }
        emit(
            "starting",
            "Starting the project and waiting for its original port...",
        );
        let replacement = launch::launch(&plan.recipe, || {
            let c = lock(&s.core)?;
            if c.ignored(&row.record) {
                return Err("The project was ignored before its replacement started.".into());
            }
            Ok(c)
        })?;
        {
            let mut c = lock(&s.core)?;
            remember(&mut c, replacement);
            c.model.event("restarted", row.record.clone(), now());
            c.dirty = true;
        }
        Ok(format!(
            "Restarted on {}.",
            plan.recipe
                .ports
                .iter()
                .map(|p| format!(":{p}"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    };
    let result = run();
    let ok = result.is_ok();
    let message = result.unwrap_or_else(|e| e);
    emit(if ok { "ready" } else { "failed" }, &message);
    scan(app, s)?;
    Ok(json!({"ok":ok,"port":port,"message":message}))
}
fn notify_stopped(app: &AppHandle, rows: &[Row]) {
    let enabled = crate::settings::snapshot(app)["notifyOnStop"] == true;
    for row in rows {
        notify(app, enabled, "Listener disappeared", row)
    }
}
pub(super) fn operate(
    app: Option<&AppHandle>,
    s: &Servers,
    method: &str,
    arg: Value,
) -> Result<Value> {
    let _op = s
        .operation
        .try_lock()
        .map_err(|_| "A server operation is already running.")?;
    match method {
        "stopServers" => stop(s, &Scope::parse(arg)?, app),
        "startServers" => start_stopped(s, &Scope::parse(arg)?, app),
        "restartServer" => {
            let r: Reference = parse(arg)?;
            if !r.valid() {
                return Err("Invalid service reference.".into());
            }
            restart(s, r, app)
        }
        _ => Err("Unknown server control.".into()),
    }
}
pub(super) fn open(app: &AppHandle, s: &Servers, method: &str, arg: Value) -> Result<Value> {
    if method == "openUrl" {
        let url = arg.as_str().ok_or("Invalid service URL.")?;
        let c = lock(&s.core)?;
        if !c.live.values().any(|r| {
            r.public["url"] == url
                && (r.discovery != "unidentified" || r.public["answersHttp"] == true)
        }) {
            return Err("This service URL is no longer available.".into());
        }
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Could not open the service URL.")?;
        return Ok(Value::Null);
    }
    let input = if method == "openInVSCode" {
        arg["path"].as_str()
    } else {
        arg.as_str()
    }
    .ok_or("Invalid project folder.")?;
    if !lock(&s.core)?
        .model
        .projects
        .iter()
        .any(|p| p.directory == input)
    {
        return Err("Unknown project folder.".into());
    }
    let path = Path::new(input)
        .canonicalize()
        .ok()
        .filter(|p| p.is_dir())
        .ok_or("Project directory was not found.")?;
    let native_path = project::display(&path);
    match method {
        "openProjectFolder" => app
            .opener()
            .open_path(&native_path, None::<&str>)
            .map_err(|_| "Could not open project folder.")?,
        #[cfg(windows)]
        "openInVSCode" => {
            let mut url = url::Url::parse("vscode://file/").unwrap();
            {
                let mut segments = url.path_segments_mut().unwrap();
                segments.clear();
                for segment in native_path
                    .replace('\\', "/")
                    .split('/')
                    .filter(|p| !p.is_empty())
                {
                    segments.push(segment);
                }
            }
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|_| "Could not open Visual Studio Code.")?;
        }
        #[cfg(target_os = "macos")]
        "openInVSCode" => {
            if !Command::new("/usr/bin/open")
                .args(["-a", "Visual Studio Code", "--"])
                .arg(&path)
                .status()
                .map_err(|_| "Could not open Visual Studio Code.")?
                .success()
            {
                return Err("Could not open Visual Studio Code.".into());
            }
        }
        #[cfg(target_os = "linux")]
        "openInVSCode" => {
            let mut child = Command::new("code")
                .arg(&path)
                .spawn()
                .map_err(|_| "Could not open Visual Studio Code.")?;
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
        "openTerminal" => terminal(&path)?,
        _ => return Err("Unknown project action.".into()),
    }
    Ok(Value::Null)
}
fn terminal(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        super::windows::open_terminal(path)?;
    }
    #[cfg(target_os = "macos")]
    {
        if !Command::new("/usr/bin/open")
            .args(["-a", "Terminal", "--"])
            .arg(path)
            .status()
            .map_err(|_| "Could not open Terminal.")?
            .success()
        {
            return Err("Could not open Terminal.".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("/usr/bin/x-terminal-emulator")
            .current_dir(path)
            .spawn()
            .map_err(|_| "Could not open terminal.")?;
    }
    Ok(())
}
