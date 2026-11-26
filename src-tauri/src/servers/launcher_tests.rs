use super::*;
use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
};
use tempfile::TempDir;

// This harness only authorizes identities descended from the child it created.
// No externally discovered listener can become a test cleanup or restart target.
struct Fixture {
    _root: TempDir,
    dir: PathBuf,
    port: u16,
    child: Option<Child>,
    known: Vec<Identity>,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        fs::write(dir.join("server.cjs"),r#"const fs=require("node:fs"),http=require("node:http");
if(fs.existsSync("fail"))process.exit(25);
const body=JSON.stringify({pid:process.pid,parent:process.ppid,args:process.argv.slice(2),env:process.env.TEST_DASHBOARD_SERVER_KEY,boot:fs.readFileSync("boot","utf8")});
http.createServer((q,r)=>{r.setHeader("content-length",Buffer.byteLength(body));r.end(body)}).listen(Number(process.env.FIXTURE_PORT),"127.0.0.1");"#).unwrap();
        fs::write(dir.join("boot"), "first").unwrap();
        Self {
            _root: root,
            dir,
            port,
            child: None,
            known: vec![],
        }
    }
    fn start(&mut self, cwd: &Path, exe: &Path, args: &[OsString]) {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .env("FIXTURE_PORT", self.port.to_string())
            .env("TEST_DASHBOARD_SERVER_KEY", "test-only & বাংলা")
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(windows_sys::Win32::System::Threading::DETACHED_PROCESS);
        }
        self.child = Some(cmd.spawn().unwrap());
        self.known
            .push(native::identity(self.child.as_ref().unwrap().id()).unwrap());
    }
    fn response(&mut self) -> Value {
        let end = Instant::now() + Duration::from_secs(18);
        let result = loop {
            if let Ok(mut conn) = TcpStream::connect_timeout(
                &([127, 0, 0, 1], self.port).into(),
                Duration::from_millis(200),
            ) {
                conn.set_read_timeout(Some(Duration::from_millis(700)))
                    .unwrap();
                let _ = write!(
                    conn,
                    "GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                );
                let mut buf = String::new();
                let _ = conn.read_to_string(&mut buf);
                if let Some(value) = buf
                    .split_once("\r\n\r\n")
                    .and_then(|(_, s)| serde_json::from_str::<Value>(s).ok())
                {
                    if value["env"] == "test-only & বাংলা" {
                        break value;
                    }
                }
            }
            assert!(
                Instant::now() < end,
                "Fixture did not serve its HTTP endpoint"
            );
            thread::sleep(Duration::from_millis(70));
        };
        let pid = result["pid"].as_u64().unwrap() as u32;
        let mut table = Table::default();
        table.refresh();
        self.extend_descendants(&table);
        assert!(self
            .known
            .iter()
            .any(|id| id.pid == pid && native::identity(pid).as_ref() == Some(id)));
        result
    }
    fn extend_descendants(&mut self, table: &Table) {
        for root in self.known.clone() {
            if native::identity(root.pid).as_ref() != Some(&root) {
                continue;
            }
            for child in table.descendants(&root).unwrap() {
                if !self.known.contains(&child) {
                    self.known.push(child)
                }
            }
        }
    }
    fn plan(&mut self, pid: u32) -> Result<launch::Plan> {
        let id = self
            .known
            .iter()
            .find(|i| i.pid == pid && native::identity(pid).as_ref() == Some(i))
            .cloned()
            .ok_or("Unknown fixture PID.")?;
        let mut table = Table::default();
        table.refresh();
        self.extend_descendants(&table);
        let allowed = self.known.iter().cloned().map(|id| (id.pid, id)).collect();
        let plan = launch::plan(&table, &id, &native::listeners()?, &allowed)?;
        assert!(plan.tree.iter().all(|id| self.known.contains(id)));
        Ok(plan)
    }
    fn restart(&mut self, pid: u32) -> Result<()> {
        let p = self.plan(pid)?;
        let mut table = Table::default();
        table.refresh();
        launch::preflight(&p.recipe)?;
        launch::verify_plan(&p, &table, &native::listeners()?)?;
        launch::stop_tree(&p)?;
        let ids = launch::launch(&p.recipe, || Ok(()))?;
        self.known.extend(ids);
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let mut table = Table::default();
        table.refresh();
        for root in self.known.clone() {
            if native::identity(root.pid).as_ref() == Some(&root) {
                if let Ok(children) = table.descendants(&root) {
                    for id in children {
                        if !self.known.contains(&id) {
                            self.known.push(id)
                        }
                    }
                }
            }
        }
        for id in &self.known {
            if native::identity(id.pid).as_ref() == Some(id) {
                let _ = native::stop(id);
            }
        }
        if let Some(c) = self.child.as_mut() {
            let _ = c.wait();
        }
    }
}
fn runtime_exe(name: &str) -> PathBuf {
    let key = std::env::var_os("PATH").unwrap();
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    std::env::split_paths(&key)
        .map(|p| p.join(&file))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is required for this integration test"))
}

#[test]
fn real_node_npm_workspace_preserves_hooks_and_forwarded_arguments() {
    let mut f = Fixture::new("project & বাংলা/web");
    let root = f.dir.parent().unwrap().to_owned();
    fs::write(
        root.join("package.json"),
        r#"{"name":"fixture-root","private":true,"workspaces":["web"]}"#,
    )
    .unwrap();
    fs::write(f.dir.join("package.json"),r#"{"name":"fixture-web","scripts":{"preserve":"node hook.cjs","serve":"node server.cjs"}}"#).unwrap();
    fs::write(
        f.dir.join("hook.cjs"),
        r#"require("node:fs").appendFileSync("hooks","hook\n");"#,
    )
    .unwrap();
    let node = runtime_exe("node");
    let node_dir = node.parent().unwrap();
    let npm = std::env::var_os("npm_execpath")
        .map(PathBuf::from)
        .filter(|p| p.file_name().is_some_and(|n| n == "npm-cli.js") && p.is_file())
        .or_else(|| {
            [
                node_dir.join("node_modules/npm/bin/npm-cli.js"),
                node_dir.join("../lib/node_modules/npm/bin/npm-cli.js"),
                node_dir.join("../share/nodejs/npm/bin/npm-cli.js"),
            ]
            .into_iter()
            .find(|p| p.is_file())
        })
        .expect("npm CLI path");
    let mut args = vec![npm.into_os_string()];
    args.extend(
        [
            "run",
            "serve",
            "--workspace",
            "fixture-web",
            "--",
            "two words",
            "--flag=123",
        ]
        .map(OsString::from),
    );
    f.start(&root, &node, &args);
    let before = f.response();
    fs::write(f.dir.join("boot"), "second").unwrap();
    f.restart(before["pid"].as_u64().unwrap() as u32).unwrap();
    let after = f.response();
    assert_ne!(before["pid"], after["pid"]);
    assert_eq!(after["args"], before["args"]);
    assert_eq!(after["boot"], "second");
    assert_eq!(after["env"], before["env"]);
    assert_eq!(
        fs::read_to_string(f.dir.join("hooks"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}
#[test]
fn real_watcher_restarts_launcher_and_child_once() {
    let mut f = Fixture::new("watcher");
    fs::write(f.dir.join("watch.cjs"),r#"const {spawn}=require("node:child_process");function run(){const c=spawn(process.execPath,["server.cjs"],{stdio:"ignore"});c.on("exit",()=>setTimeout(run,25));}run();"#).unwrap();
    f.start(&f.dir.clone(), &runtime_exe("node"), &["watch.cjs".into()]);
    let before = f.response();
    f.restart(before["pid"].as_u64().unwrap() as u32).unwrap();
    let after = f.response();
    assert_ne!(after["pid"], before["pid"]);
    assert_ne!(after["parent"], before["parent"]);
    let owners: HashSet<_> = native::listeners()
        .unwrap()
        .into_iter()
        .filter(|l| l.port == f.port)
        .map(|l| l.pid)
        .collect();
    assert_eq!(owners.len(), 1);
}
#[test]
fn sibling_servers_in_a_shared_launcher_remain_running() {
    let mut a = Fixture::new("shared A");
    let b = Fixture::new("shared B");
    let script = format!(
        r#"const {{spawn}}=require("node:child_process");for (const [cwd,port] of [[process.cwd(),process.env.FIXTURE_PORT],[{},{}]])spawn(process.execPath,["server.cjs"],{{cwd,env:{{...process.env,FIXTURE_PORT:String(port)}},stdio:"ignore"}});setInterval(()=>{{}},1000);"#,
        json!(project::display(&b.dir)),
        b.port
    );
    fs::write(a.dir.join("shared.cjs"), script).unwrap();
    a.start(&a.dir.clone(), &runtime_exe("node"), &["shared.cjs".into()]);
    let before = a.response();
    let end = Instant::now() + Duration::from_secs(10);
    while !native::listeners()
        .unwrap()
        .iter()
        .any(|l| l.port == b.port)
    {
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(80));
    }
    assert!(a.plan(before["pid"].as_u64().unwrap() as u32).is_err());
    assert_eq!(a.response()["pid"], before["pid"]);
    assert!(native::listeners()
        .unwrap()
        .iter()
        .any(|l| l.port == b.port));
}
#[test]
fn failed_restart_reports_exit_without_retrying() {
    let mut f = Fixture::new("failed");
    f.start(&f.dir.clone(), &runtime_exe("node"), &["server.cjs".into()]);
    let before = f.response();
    fs::write(f.dir.join("fail"), "").unwrap();
    assert!(f.restart(before["pid"].as_u64().unwrap() as u32).is_err());
    assert!(!native::listeners()
        .unwrap()
        .iter()
        .any(|l| l.port == f.port));
}
#[test]
fn real_vite_reopens_the_configured_endpoint() {
    let mut f = Fixture::new("Vite");
    let vite = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/vite/bin/vite.js")
        .canonicalize()
        .expect("Install frontend packages before running Vite parity tests.");
    fs::write(f.dir.join("vite.config.mjs"),r#"import fs from 'node:fs';const body=JSON.stringify({pid:process.pid,env:process.env.TEST_DASHBOARD_SERVER_KEY,boot:fs.readFileSync("boot","utf8")});export default {server:{watch:{usePolling:true}},plugins:[{name:'test',configureServer(s){s.middlewares.use((req,res)=>{res.setHeader('content-length',Buffer.byteLength(body));res.end(body)})}}]};"#).unwrap();
    let port = f.port.to_string();
    f.start(
        &f.dir.clone(),
        &runtime_exe("node"),
        &[
            project::display(&vite).into(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.into(),
            "--strictPort".into(),
        ],
    );
    let before = f.response();
    fs::write(f.dir.join("boot"), "changed").unwrap();
    f.restart(before["pid"].as_u64().unwrap() as u32).unwrap();
    let after = f.response();
    assert_eq!(after["boot"], "changed");
    assert_ne!(after["pid"], before["pid"]);
}
#[test]
fn real_python_preserves_interpreter_cwd_and_arguments() {
    let mut f = Fixture::new("Python پروژه");
    let python = std::env::var_os("DASHBOARD_TEST_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_exe(if cfg!(windows) { "python" } else { "python3" }));
    fs::write(f.dir.join("server.py"),r#"import json,os,sys
from http.server import BaseHTTPRequestHandler
from socketserver import TCPServer
boot=open("boot").read()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  data=json.dumps(dict(pid=os.getpid(),env=os.environ["TEST_DASHBOARD_SERVER_KEY"],args=sys.argv[1:],boot=boot)).encode()
  self.send_response(200)
  self.send_header("Content-Length",str(len(data)))
  self.end_headers()
  self.wfile.write(data)
TCPServer.allow_reuse_address=True
TCPServer(("127.0.0.1",int(os.environ["FIXTURE_PORT"])),Handler).serve_forever()
"#).unwrap();
    f.start(
        &f.dir.clone(),
        &python,
        &["server.py".into(), "two words".into()],
    );
    let before = f.response();
    fs::write(f.dir.join("boot"), "changed").unwrap();
    f.restart(before["pid"].as_u64().unwrap() as u32).unwrap();
    let after = f.response();
    assert_ne!(after["pid"], before["pid"]);
    assert_eq!(after["args"], json!(["two words"]));
    assert_eq!(after["boot"], "changed");
}
