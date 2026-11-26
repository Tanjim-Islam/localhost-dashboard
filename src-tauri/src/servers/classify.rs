use super::{
    native::{Identity, Table},
    project::{clean, display, identify, Evidence},
};
use serde_json::{json, Value};
use std::{ffi::OsString, path::Path};

pub fn basename(p: &Path) -> String {
    let text = p
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    text.strip_suffix(".exe").unwrap_or(&text).to_owned()
}
pub fn runtime(name: &str) -> bool {
    [
        "node", "nodejs", "bun", "deno", "dotnet", "java", "go", "uvicorn", "gunicorn",
    ]
    .contains(&name)
        || ["python", "php", "ruby"].iter().any(|p| {
            name.strip_prefix(p)
                .is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
        })
}
pub fn shell(name: &str) -> bool {
    ["cmd", "powershell", "pwsh", "bash", "zsh", "sh", "fish"].contains(&name)
}
fn installed(path: &Path) -> bool {
    let s = display(path).replace('\\', "/").to_lowercase();
    [
        "/program files/",
        "/program files (x86)/",
        "/windowsapps/",
        "/appdata/roaming/",
        "/appdata/local/",
    ]
    .iter()
    .any(|p| s.contains(p))
        || [
            "/applications/",
            "/system/applications/",
            "/system/library/",
            "/usr/libexec/",
        ]
        .iter()
        .any(|p| s.starts_with(p))
}
fn app_name(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "code" => "Visual Studio Code",
        "raycast" => "Raycast",
        "com.docker.backend" => "Docker",
        "electron" => "Electron",
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "idmintegrator64" => "Internet Download Manager",
        "ollama" => "Ollama",
        "local-dashboard" => "Localhost Dashboard",
        _ => name,
    }
    .to_string()
}
pub fn system_process(id: &Identity) -> bool {
    let p = display(&id.exe).replace('\\', "/").to_lowercase();
    id.pid <= 4
        || p.get(2..).is_some_and(|s| s.starts_with("/windows/"))
        || p.starts_with("/system/")
        || p.starts_with("/usr/libexec/")
}
fn application(table: &Table, id: &Identity) -> Option<Value> {
    let exe = display(&id.exe);
    let app = |name: &str, path: &Path, evidence: &str| json!({"name":app_name(name),"executable":display(path),"evidence":evidence});
    if cfg!(target_os = "macos") {
        if let Some((base, _)) = exe.split_once(".app/Contents/") {
            if !(exe.contains(".framework/Versions/")
                && exe.ends_with("/Resources/Python.app/Contents/MacOS/Python"))
            {
                return Some(app(base.rsplit('/').next()?, &id.exe, "app-bundle"));
            }
        }
    }
    for parent_pid in table.ancestors(id.pid, 12).iter().skip(1) {
        let Some(exe) = table.process(*parent_pid).and_then(|p| p.exe()) else {
            break;
        };
        let name = basename(exe);
        if runtime(&name)
            || shell(&name)
            || [
                "terminal",
                "windowsterminal",
                "conhost",
                "explorer",
                "launchd",
                "services",
                "svchost",
                "system",
            ]
            .contains(&name.as_str())
        {
            continue;
        }
        if installed(exe)
            && exe.parent().is_some_and(|p| {
                super::project::path_key(&id.exe)
                    .starts_with(&(super::project::path_key(p) + std::path::MAIN_SEPARATOR_STR))
            })
        {
            return Some(app(&name, exe, "bundled-runtime"));
        }
    }
    let name = basename(&id.exe);
    if id.pid == std::process::id()
        || ["electron", "chrome", "msedge", "firefox", "brave", "code"].contains(&name.as_str())
        || (!runtime(&name) && !shell(&name) && installed(&id.exe))
    {
        return Some(app(&name, &id.exe, "application-process"));
    }
    None
}
pub struct Classification {
    pub discovery: &'static str,
    pub service: String,
    pub framework: Option<String>,
    pub app: Option<Value>,
    pub evidence: Option<Evidence>,
}
pub fn classify(
    table: &Table,
    id: Option<&Identity>,
    name: &str,
    cwd: Option<&Path>,
    argv: &[OsString],
) -> Classification {
    let base = basename(Path::new(name));
    let command = argv
        .iter()
        .map(|x| x.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let words: Vec<_> = command
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .collect();
    let keywords = [
        ("vite", "Vite"),
        ("next", "Next.js"),
        ("nuxt", "Nuxt"),
        ("astro", "Astro"),
        ("angular", "Angular"),
        ("uvicorn", "Uvicorn"),
        ("gunicorn", "Gunicorn"),
        ("django", "Django"),
        ("odoo", "Odoo"),
        ("flask", "Flask"),
        ("fastapi", "FastAPI"),
        ("simplehttpserver", "Python HTTP"),
        ("rails", "Rails"),
    ];
    let framework = if [
        "electron",
        "chrome",
        "msedge",
        "code",
        "svchost",
        "system",
        "services",
        "controlcenter",
    ]
    .contains(&base.as_str())
    {
        None
    } else {
        keywords
            .iter()
            .find(|(k, _)| words.contains(k))
            .map(|(_, v)| *v)
            .or_else(|| {
                if command.contains("manage.py") {
                    Some("Django")
                } else if command.contains("http.server") {
                    Some("Python HTTP")
                } else {
                    None
                }
            })
    };
    let label = framework.or_else(|| match base.as_str() {
        "node" | "nodejs" => Some("Node.js"),
        "dotnet" => Some(".NET"),
        "java" => Some("Java"),
        "go" => Some("Go"),
        "bun" => Some("Bun"),
        "deno" => Some("Deno"),
        n if n.starts_with("python") && runtime(n) => Some("Python"),
        n if runtime(n) => Some(n),
        _ => None,
    });
    let app = id.and_then(|id| application(table, id));
    let evidence = if app.is_none() {
        cwd.and_then(|c| identify(c, argv))
    } else {
        None
    };
    let script = |s: &OsString| {
        Path::new(s)
            .extension()
            .and_then(|p| p.to_str())
            .is_some_and(|ext| {
                ["js", "mjs", "cjs", "ts", "py", "rb", "php"]
                    .iter()
                    .any(|x| ext.eq_ignore_ascii_case(x))
            })
    };
    let installed_script = id.is_some_and(|i| installed(&i.exe))
        && argv
            .iter()
            .skip(1)
            .any(|s| script(s) && installed(Path::new(s)));
    let development = evidence.is_some()
        || (!argv.is_empty()
            && (framework.is_some()
                || (runtime(&base)
                    && !installed_script
                    && (argv.iter().skip(1).any(script) || command.contains("createserver(")))));
    let discovery = if app.is_some() {
        "application"
    } else if development {
        "development"
    } else {
        "unidentified"
    };
    let service = app
        .as_ref()
        .and_then(|a| a["name"].as_str())
        .or(evidence.as_ref().and_then(|e| e.service_name.as_deref()))
        .unwrap_or_else(|| {
            if discovery == "unidentified" {
                return if name.eq_ignore_ascii_case("system") {
                    "Windows System"
                } else if name.is_empty() {
                    "Local listener"
                } else {
                    name.strip_suffix(".exe").unwrap_or(name)
                };
            }
            match label {
                Some("Vite" | "Nuxt" | "Next.js" | "Astro" | "Angular") => "Frontend",
                Some("Uvicorn" | "Gunicorn" | "Django" | "Rails" | "Flask" | "FastAPI") => "API",
                Some(s) => s,
                None => "Local listener",
            }
        })
        .to_string();
    Classification {
        discovery,
        service: clean(&service, 120),
        framework: label.map(str::to_owned),
        app,
        evidence,
    }
}
