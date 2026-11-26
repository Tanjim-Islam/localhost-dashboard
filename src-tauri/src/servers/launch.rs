use super::{
    classify::{basename, runtime, shell, system_process},
    native::{self, Context, Identity, Listener, Result, Table},
    project::path_key,
};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    ffi::OsStr,
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Recipe {
    pub launch: Arc<Context>,
    pub ports: BTreeSet<u16>,
}
pub struct Plan {
    pub recipe: Recipe,
    pub tree: Vec<Identity>,
}

pub fn protected(table: &Table, id: &Identity, allowed: &HashMap<u32, Identity>) -> bool {
    if system_process(id) {
        return true;
    }
    let own = std::process::id();
    if table.ancestors(own, 32).contains(&id.pid) {
        return true;
    }
    table.ancestors(id.pid, 64).contains(&own) && allowed.get(&id.pid) != Some(id)
}
pub fn plan(
    table: &Table,
    selected: &Identity,
    listeners: &[Listener],
    allowed: &HashMap<u32, Identity>,
) -> Result<Plan> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("Server restart is available on Windows and macOS.".into());
    }
    if protected(table, selected, allowed) {
        return Err("This process is protected.".into());
    }
    let selected_context = table
        .context(selected)
        .ok_or("Cannot read the original launch context. Restart the server from its terminal.")?;
    let cwd = path_key(&selected_context.cwd);
    let mut contexts = vec![selected_context];
    let mut launch_index = 0;
    let ancestors = table.ancestors(selected.pid, 16);
    let own_ancestors = table.ancestors(std::process::id(), 32);
    for (index, &ppid) in ancestors.iter().enumerate().skip(1) {
        if own_ancestors.contains(&ppid) {
            break;
        }
        let p = table.process(ppid).ok_or("Launcher changed.")?;
        let name = basename(Path::new(p.name()));
        if [
            "services",
            "svchost",
            "nssm",
            "winsw",
            "launchd",
            "systemd",
            "supervisord",
            "wsl",
            "wslhost",
            "docker",
            "com.docker.backend",
        ]
        .contains(&name.as_str())
        {
            // A detached process reparented to init retains its directly observed context.
            if ppid == 1 && index > 1 {
                break;
            }
            return Err(
                "This server is managed by a service or container. Restart it through its owner."
                    .into(),
            );
        }
        if !shell(&name)
            && !runtime(&name)
            && !["cargo", "uv", "npm", "pnpm", "yarn"].contains(&name.as_str())
        {
            if ["forever", "pm2"].contains(&name.as_str()) {
                return Err("Restart this server through its supervisor.".into());
            }
            break;
        }
        let id = native::identity(ppid).ok_or("The launcher's identity could not be confirmed.")?;
        if id.started > contexts.last().unwrap().id.started {
            break;
        }
        let context = table
            .context(&id)
            .ok_or("The parent launcher's original context is unavailable.")?;
        if shell(&name) {
            if !context
                .argv
                .iter()
                .any(|s| s == "-c" || s.to_str().is_some_and(|s| s.eq_ignore_ascii_case("/c")))
            {
                break;
            }
            contexts.push(context);
            continue;
        }
        #[cfg(target_os = "macos")]
        let context = {
            let mut ctx = context;
            super::npm::recover(&mut ctx, &contexts)?;
            ctx
        };
        let cli = context.argv.get(1).map(Path::new);
        let npm = cli.is_some_and(|p| p.file_name().is_some_and(|n| n == "npm-cli.js"));
        let npm_owns = npm
            && contexts.iter().any(|ctx| {
                let get = |key: &str| ctx.env.get(OsStr::new(key)).map(Path::new);
                get("npm_execpath")
                    .is_some_and(|env_cli| cli.is_some_and(|p| same_file(p, env_cli)))
                    && get("npm_package_json")
                        .and_then(Path::parent)
                        .is_some_and(|p| same_file(p, &contexts[0].cwd))
            });
        if path_key(&context.cwd) != cwd && !npm_owns {
            return Err("The parent launcher uses another project folder.".into());
        }
        contexts.push(context);
        launch_index = contexts.len() - 1;
    }
    let launch = contexts.swap_remove(launch_index);
    let name = basename(&launch.id.exe);
    if !(runtime(&name) || ["cargo", "uv", "npm", "pnpm", "yarn"].contains(&name.as_str()))
        || name == "java"
    {
        return Err("Automatic restart requires a supported development launcher.".into());
    }
    if !launch.id.exe.is_absolute()
        || !launch.cwd.is_absolute()
        || launch.argv.len() < 2
        || launch.argv[1].is_empty()
        || launch.env.is_empty()
    {
        return Err("The original launch details are incomplete.".into());
    }
    let title = launch.argv[0].to_string_lossy().to_lowercase();
    if ["next-server", "npm ", "node ("]
        .iter()
        .any(|s| title.starts_with(s))
    {
        return Err("The launcher replaced its original arguments.".into());
    }
    if launch.argv.iter().any(|s| {
        s.to_string_lossy()
            .to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|s| s == "pm2" || s == "forever")
    }) {
        return Err("Restart this server through its supervisor.".into());
    }
    let tree = table.descendants(&launch.id)?;
    if !tree.contains(selected) || tree.iter().any(|i| protected(table, i, allowed)) {
        return Err("The launcher shares a protected process tree.".into());
    }
    let ids: HashSet<_> = tree.iter().map(|i| i.pid).collect();
    let own_tree: HashSet<_> = table
        .descendants(selected)?
        .into_iter()
        .map(|i| i.pid)
        .collect();
    let selected_ports: BTreeSet<_> = listeners
        .iter()
        .filter(|l| l.pid == selected.pid)
        .map(|l| l.port)
        .collect();
    if selected_ports.is_empty() {
        return Err("The selected server is no longer listening.".into());
    }
    let mut ports = BTreeSet::new();
    for listener in listeners.iter().filter(|l| ids.contains(&l.pid)) {
        if !selected_ports.contains(&listener.port) && !own_tree.contains(&listener.pid) {
            return Err("The launcher also runs another server.".into());
        }
        ports.insert(listener.port);
    }
    if listeners
        .iter()
        .any(|l| ports.contains(&l.port) && !ids.contains(&l.pid))
    {
        return Err("Another process also owns a selected port.".into());
    }
    Ok(Plan {
        recipe: Recipe {
            launch: Arc::new(launch),
            ports,
        },
        tree,
    })
}
fn same_file(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(l, r)| path_key(&l) == path_key(&r))
}
pub fn preflight(recipe: &Recipe) -> Result<()> {
    if !recipe.launch.id.exe.is_file() || !recipe.launch.cwd.is_dir() {
        return Err("The original executable or project folder is missing.".into());
    }
    Ok(())
}
pub fn verify_plan(plan: &Plan, table: &Table, listeners: &[Listener]) -> Result<()> {
    let tree = table.descendants(&plan.recipe.launch.id)?;
    if tree.len() != plan.tree.len() || tree.iter().any(|id| !plan.tree.contains(id)) {
        return Err("The process tree changed. Refresh and try again.".into());
    }
    let ids: HashSet<_> = tree.iter().map(|id| id.pid).collect();
    let ports: BTreeSet<_> = listeners
        .iter()
        .filter(|l| ids.contains(&l.pid))
        .map(|l| l.port)
        .collect();
    if ports != plan.recipe.ports
        || listeners
            .iter()
            .any(|l| ports.contains(&l.port) && !ids.contains(&l.pid))
    {
        return Err("Port ownership changed. Nothing was stopped.".into());
    }
    Ok(())
}
pub fn stop_tree(plan: &Plan) -> Result<()> {
    #[cfg(windows)]
    let interrupted = super::windows::interrupt(&plan.tree);
    #[cfg(target_os = "macos")]
    let interrupted = plan
        .tree
        .iter()
        .all(|id| native::identity(id.pid).as_ref() == Some(id))
        && plan
            .tree
            .iter()
            .all(|id| unsafe { libc::kill(id.pid as i32, libc::SIGINT) } == 0);
    #[cfg(not(any(windows, target_os = "macos")))]
    let interrupted = false;
    let deadline = Instant::now() + Duration::from_secs(if interrupted { 5 } else { 0 });
    let mut known = plan.tree.clone();
    loop {
        let mut table = Table::default();
        table.refresh();
        for root in known.clone() {
            if native::identity(root.pid).as_ref() != Some(&root) {
                continue;
            }
            for child in table.descendants(&root)? {
                if !known.contains(&child) {
                    known.push(child)
                }
                if known.len() > 128 {
                    return Err("Launcher acquired too many children. Restart it manually.".into());
                }
            }
        }
        if known
            .iter()
            .all(|id| native::identity(id.pid).as_ref() != Some(id))
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(150))
    }
    for id in &known {
        if native::identity(id.pid).as_ref() == Some(id) {
            native::stop(id)?;
        }
    }
    for _ in 0..15 {
        if known
            .iter()
            .all(|id| native::identity(id.pid).as_ref() != Some(id))
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("The launcher did not fully stop. No replacement was started.".into())
}
pub fn launch(recipe: &Recipe) -> Result<Vec<Identity>> {
    preflight(recipe)?;
    if native::listeners()?
        .iter()
        .any(|l| recipe.ports.contains(&l.port))
    {
        return Err("An original port is already in use.".into());
    }
    if native::identity(recipe.launch.id.pid).as_ref() == Some(&recipe.launch.id) {
        return Err("The original launcher is still running.".into());
    }
    let ctx = &recipe.launch;
    let mut command = Command::new(&ctx.id.exe);
    command
        .args(&ctx.argv[1..])
        .env_clear()
        .envs(&ctx.env)
        .current_dir(&ctx.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.arg0(&ctx.argv[0]).process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the original launch command.")?;
    let root = native::identity(child.id())
        .filter(|i| path_key(&i.exe) == path_key(&ctx.id.exe))
        .ok_or("The launched process identity could not be verified.")?;
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut stable = None;
    let mut known = vec![root.clone()];
    let result = loop {
        if Instant::now() > deadline {
            break Err("The original ports did not return within 45 seconds. Check the project before retrying.".into());
        }
        let listeners = native::listeners()?;
        let mut table = Table::default();
        table.refresh();
        if native::identity(root.pid).as_ref() == Some(&root) {
            for id in table.descendants(&root)? {
                if !known.contains(&id) {
                    known.push(id)
                }
            }
        }
        let live: Vec<_> = known
            .iter()
            .filter(|id| native::identity(id.pid).as_ref() == Some(*id))
            .cloned()
            .collect();
        let mut ready = BTreeSet::new();
        for listener in listeners.iter().filter(|l| recipe.ports.contains(&l.port)) {
            if !live.iter().any(|id| id.pid == listener.pid) {
                return Err("A different process took an original port.".into());
            }
            ready.insert(listener.port);
        }
        if ready == recipe.ports {
            if stable.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(1) {
                break Ok(live);
            }
        } else {
            stable = None
        }
        if live.is_empty() && child.try_wait().ok().flatten().is_some() {
            break Err("The project exited before reopening its port.".into());
        }
        thread::sleep(Duration::from_millis(200));
    };
    #[cfg(unix)]
    thread::spawn(move || {
        let _ = child.wait();
    });
    result
}
