// Native Electron QA. Only generated fixture PIDs are used for stop/restart.
// Set DASHBOARD_PLAYWRIGHT_MODULE to a bundled Playwright module when needed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: pause } = require("node:timers/promises");
const { _electron } = require(
  process.env.DASHBOARD_PLAYWRIGHT_MODULE || "playwright",
);
const {
  NativeProcessHost,
} = require("../.tmp-tests/src/main/server-restart/native-host.js");
const {
  emptyProjectState,
  ProjectModel,
} = require("../.tmp-tests/src/main/projects/model.js");
const rootDir = path.resolve(__dirname, "..");
const inspector = new NativeProcessHost(
  path.join(rootDir, "resources/server-restart"),
);
const owned = new Map(),
  children = [],
  errors = [],
  passed = [];
let root, app, page, search;
const runFile = promisify(execFile);
const pass = (name) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
async function until(read, check, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (check(value)) return value;
    await pause(200);
  } while (Date.now() < deadline);
  throw new Error(message);
}
const servers = () => page.evaluate(() => window.api.getServers());
const projects = () => page.evaluate(() => window.api.getProjects());
async function remember(pid) {
  const snapshot = await inspector.snapshot(pid);
  const identity = snapshot.processes.find((p) => p.pid === pid);
  if (identity) owned.set(pid, identity);
  return identity;
}
async function fixture(directory, family) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: family }),
  );
  const script = path.join(directory, "server.cjs");
  await fs.writeFile(
    script,
    `const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,r)=>{if(fs.existsSync('hang'))return;r.end(JSON.stringify({pid:process.pid,cwd:process.cwd()}))});server.listen(Number(process.env.DASHBOARD_UI_PORT)||0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));`,
  );
  const reservation = require("node:net").createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, DASHBOARD_UI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const value = await new Promise((resolve, reject) => {
    child.stdout.once("data", (data) => resolve(JSON.parse(data)));
    child.once("error", reject);
  });
  await remember(value.pid);
  return { ...value, directory };
}
async function applicationFixture() {
  // A real Mach-O listener inside a generated app bundle exercises native
  // application classification without touching installed applications.
  const directory = path.join(root, "Mac QA Application.app/Contents/MacOS");
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(root, "application-fixture.c");
  const executable = path.join(directory, "qa-listener");
  await fs.writeFile(
    source,
    `
#include <arpa/inet.h>
#include <stdio.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {
  signal(SIGPIPE, SIG_IGN);
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  socklen_t len = sizeof(addr);
  if (fd < 0 || bind(fd, (struct sockaddr *)&addr, len) || listen(fd, 8)) return 1;
  getsockname(fd, (struct sockaddr *)&addr, &len);
  printf("{\\"pid\\":%d,\\"port\\":%d}\\n", getpid(), ntohs(addr.sin_port));
  fflush(stdout);
  for (;;) {
    int client = accept(fd, NULL, NULL);
    if (client < 0) continue;
    const char reply[] = "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK";
    send(client, reply, sizeof(reply) - 1, 0);
    close(client);
  }
}`,
  );
  await runFile("/usr/bin/clang", [source, "-o", executable]);
  const child = spawn(executable, [], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const value = await new Promise((resolve, reject) => {
    child.stdout.once("data", (data) => resolve(JSON.parse(data.toString())));
    child.once("error", reject);
  });
  await remember(value.pid);
  return value;
}
async function launch() {
  const env = { ...process.env, LOCAL_DASHBOARD_CLIS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({
    executablePath:
      process.env.DASHBOARD_ELECTRON_EXECUTABLE || require("electron"),
    args: process.env.DASHBOARD_ELECTRON_EXECUTABLE ? [] : ["."],
    cwd: rootDir,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  search = page.getByPlaceholder("Search projects, services, ports");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.api?.getServers);
  await page.getByRole("button", { name: /^Servers/ }).click();
}
const card = (name) =>
  page
    .locator("article")
    .filter({ has: page.locator("h2").filter({ hasText: name }) });
async function menu(name, action) {
  await page
    .getByRole("button", { name: `Actions for ${name}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
async function theme(mode) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
}
const drawer = () =>
  page.getByRole("dialog", { name: "More services", exact: true });
async function openDrawer() {
  await page
    .getByRole("button", { name: "More services", exact: true })
    .click();
  await drawer().waitFor({ state: "visible" });
  await pause(250);
}
async function closeDrawer() {
  await drawer()
    .getByRole("button", { name: "Close more services", exact: true })
    .click();
  assert.ok(
    await page
      .locator('dialog[aria-label="More services"]')
      .evaluate((el) => el.inert),
  );
  await drawer().waitFor({ state: "hidden" });
}
async function watchStopFeedback() {
  await page.evaluate(() => {
    window.qaStopFeedback = { spinner: false, confirmation: false };
    window.qaStopObserver = new MutationObserver(() => {
      window.qaStopFeedback.spinner ||= !!document.querySelector(
        '[aria-busy="true"] .animate-spin',
      );
      window.qaStopFeedback.confirmation ||= [
        ...document.querySelectorAll('[role="dialog"],dialog[open]'),
      ].some((el) => el.textContent.includes("Stop selected processes?"));
    });
    window.qaStopObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}
async function verifyStopFeedback() {
  const feedback = await page.evaluate(() => {
    window.qaStopObserver.disconnect();
    return window.qaStopFeedback;
  });
  assert.deepEqual(feedback, { spinner: true, confirmation: false });
}
async function geometry(label) {
  const failures = await page.evaluate(() => {
    const issues = [];
    if (document.documentElement.scrollWidth > innerWidth)
      issues.push("Document overflow");
    for (const el of document.querySelectorAll("button,input,select,time")) {
      if (
        el.closest('[inert],[aria-hidden="true"]') ||
        !el.getClientRects().length
      )
        continue;
      const b = el.getBoundingClientRect();
      if (b.width && (b.left < -1 || b.right > innerWidth + 1))
        issues.push(
          `${el.getAttribute("aria-label") || el.textContent}: horizontal overflow`,
        );
    }
    return issues;
  });
  assert.deepEqual(failures, [], label);
}
async function main() {
  assert.equal(
    process.platform,
    "darwin",
    "Run native macOS UI verification on a Mac.",
  );
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-macos-ui-")),
  );
  console.log(`Native UI fixture: ${root}`);
  const mono = path.join(root, "Mac QA বাংলা & workspace");
  await fs.mkdir(mono);
  await fs.writeFile(
    path.join(mono, "package.json"),
    JSON.stringify({ name: "Mac QA Workspace", workspaces: ["apps/*"] }),
  );
  const web = await fixture(path.join(mono, "apps/web"), "Web");
  const api = await fixture(path.join(mono, "apps/api"), "API");
  const other = await fixture(path.join(root, "Other QA"), "Mac QA Other");
  const application = await applicationFixture();
  const pythonDirectory = path.join(root, "Python QA");
  await fs.mkdir(pythonDirectory);
  await fs.writeFile(
    path.join(pythonDirectory, "pyproject.toml"),
    '[project]\nname="mac-qa-python"\n',
  );
  const pythonPort = require("node:net").createServer();
  await new Promise((resolve) => pythonPort.listen(0, "::1", resolve));
  const port = pythonPort.address().port;
  await new Promise((resolve) => pythonPort.close(resolve));
  const python = spawn(
    "/usr/bin/python3",
    ["-m", "http.server", String(port), "--bind", "::1"],
    { cwd: pythonDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(python);
  await new Promise((resolve, reject) => {
    python.once("spawn", resolve);
    python.once("error", reject);
  });
  // Apple's /usr/bin/python3 launcher can exec the framework interpreter with
  // the same PID. Capture identity only after that interpreter is listening.
  await until(
    async () => {
      try {
        return (
          await fetch(`http://[::1]:${port}`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    "Python fixture did not start listening",
  );
  await until(
    () => remember(python.pid),
    Boolean,
    "Python fixture did not start",
  );
  const profile = path.join(root, "electron-app-data/Electron");
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      notifyOnStart: false,
      notifyOnStop: false,
      startAtLogin: false,
      closeToTray: true,
    }),
  );
  const model = new ProjectModel(emptyProjectState());
  model.ensure(mono, "Mac QA Workspace");
  model.state.recentlyStopped = Array.from({ length: 24 }, (_, i) => ({
    key: `${800000 + i}:${62000 + i}`,
    firstSeen: Date.now() - 100000 - i * 1000,
    pid: 800000 + i,
    port: 62000 + i,
    lastSeen: Date.now() - 10000 - i * 1000,
    stoppedAt: Date.now() - 5000 - i * 1000,
    processStarted: new Date(Date.now() - 100000).toISOString(),
    processName: i % 5 ? "node" : undefined,
    serviceName: i % 2 ? "Node.js" : "Frontend",
    projectName:
      i === 0
        ? "A deliberately long project name for checking narrow layouts without overlapping actions"
        : i % 2
          ? "Node.js"
          : "QA project",
    directory: i % 5 ? mono : undefined,
    framework: "Node.js",
    status: "listener-disappeared",
    lastStatus: i % 3 ? "listening" : "http-unresponsive",
  }));
  await fs.writeFile(
    path.join(profile, "projects.json"),
    JSON.stringify({ state: model.state }),
  );
  await fs.writeFile(
    path.join(profile, "port-notes.json"),
    JSON.stringify({ notes: { [web.port]: "Unassigned legacy QA note" } }),
  );
  await launch();
  let observations = await until(
    servers,
    (items) =>
      [web, api, other].every((f) =>
        items.some((s) => s.pid === f.pid && s.projectId),
      ),
    "Generated services were not discovered or assigned",
  );
  const webItem = observations.find((s) => s.pid === web.pid),
    apiItem = observations.find((s) => s.pid === api.pid),
    otherItem = observations.find((s) => s.pid === other.pid);
  assert.equal(webItem.projectId, apiItem.projectId);
  assert.notEqual(webItem.projectId, otherItem.projectId);
  const pythonItem = await until(
    servers,
    (items) =>
      items.some(
        (s) =>
          s.pid === python.pid && s.discovery === "development" && s.projectId,
      ),
    "Native macOS Python runtime was not recognized as a project",
  );
  assert.ok(pythonItem.find((s) => s.pid === python.pid).canStop);
  await card("Mac QA Workspace").waitFor();
  pass(
    "native arbitrary-port discovery, monorepo grouping, separate projects and Unicode paths",
  );
  assert.equal(
    await page.getByRole("button", { name: /Add project/i }).count(),
    0,
  );
  assert.equal(
    await page.getByText("Show stopped", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: /^Recently stopped/ }).count(),
    0,
  );
  for (const width of [900, 1100]) {
    await app.evaluate(
      ({ BrowserWindow }, w) =>
        BrowserWindow.getAllWindows()[0].setSize(w, 720),
      width,
    );
    await page.waitForFunction((w) => innerWidth === w, width);
    await search.fill("Mac QA Workspace");
    const grid = await card("Mac QA Workspace").evaluate((el) => ({
      card: el.getBoundingClientRect().width,
      grid: el.parentElement.getBoundingClientRect().width,
      gap: parseFloat(getComputedStyle(el.parentElement).columnGap),
      count: el.parentElement.children.length,
    }));
    assert.equal(grid.count, 1);
    assert.ok(Math.abs(grid.card * 2 + grid.gap - grid.grid) < 2);
    await geometry(`single half-width card ${width}`);
  }
  await search.fill("");
  await openDrawer();
  assert.ok(
    await drawer()
      .getByRole("button", { name: "Close more services" })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Shift+Tab");
  assert.ok(
    await drawer().evaluate((el) => el.contains(document.activeElement)),
  );
  await page.keyboard.press("Escape");
  await drawer().waitFor({ state: "hidden" });
  assert.ok(
    await page
      .getByRole("button", { name: "More services", exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDrawer();
  await closeDrawer();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  pass(
    "half-width single cards at both sizes, removed controls, drawer focus trapping, Escape and reduced motion",
  );
  const migration = await projects();
  assert.equal(migration.legacyNotes.length, 1);
  assert.ok(migration.projects.every((p) => p.notes === ""));
  pass(
    "native Python.app interpreter remains manageable and legacy port notes stay unassigned",
  );
  assert.equal(await page.evaluate(() => window.api.getCliInventory()), null);
  const update = await page.evaluate(() => window.api.getUpdateStatus());
  assert.notEqual(update.state, "error");
  if (!process.env.DASHBOARD_ELECTRON_EXECUTABLE)
    assert.equal(update.state, "idle");
  pass(
    "cached CLI startup performs no scan and updater initializes without an error",
  );

  await menu("Mac QA Workspace", "Edit project");
  const edit = page.getByRole("dialog", { name: "Edit project" });
  await edit.getByLabel("Name", { exact: true }).fill("Mac QA Renamed");
  await edit.getByLabel("Notes", { exact: true }).fill("Native Mac QA note");
  await edit.getByLabel("Pin", { exact: true }).check();
  await edit.getByLabel("Bookmark", { exact: true }).check();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await card("Mac QA Renamed").waitFor();
  await menu("Mac QA Renamed", "Ignore project");
  await page.getByRole("button", { name: /^Ignored/ }).click();
  await card("Mac QA Renamed").waitFor();
  assert.equal(await card("Mac QA Renamed").getByRole("checkbox").count(), 0);
  await app.close();
  app = null;
  await launch();
  await card("Mac QA Renamed").waitFor();
  const restored = (await projects()).projects.find(
    (p) => p.id === webItem.projectId,
  );
  assert.ok(
    !(await projects()).recentlyStopped.some((s) =>
      [web.pid, api.pid, other.pid, python.pid].includes(s.pid),
    ),
    "App restart must not invent listener-disappeared events for live fixtures",
  );
  assert.equal(restored.ignored, true);
  assert.equal(restored.notes, "Native Mac QA note");
  assert.ok(restored.pinned && restored.bookmarked);
  await menu("Mac QA Renamed", "Restore project");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await card("Mac QA Renamed").waitFor();
  pass(
    "project edits, pin, bookmark, ignored view and restoration survive a native app restart",
  );
  await until(
    servers,
    (items) =>
      [web, api, other, { pid: python.pid }].every((f) =>
        items.some((s) => s.pid === f.pid),
      ),
    "Startup scan did not restore the live fixtures",
  );
  assert.ok(
    !(await projects()).recentlyStopped.some((s) =>
      [web.pid, api.pid, other.pid, python.pid].includes(s.pid),
    ),
    "Editing cached projects before the startup scan must not invent stops",
  );

  await card("Mac QA Other")
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await card("Mac QA Other")
    .getByRole("button", { name: "Change project", exact: true })
    .click();
  const association = page.getByRole("dialog");
  await association.getByRole("combobox").selectOption(webItem.projectId);
  await association.getByRole("button", { name: "Save", exact: true }).click();
  await until(
    servers,
    (items) =>
      items.some(
        (s) => s.pid === other.pid && s.projectId === webItem.projectId,
      ),
    "Manual project correction was not applied",
  );
  await page.evaluate(
    ({ ref, projectId }) => window.api.associateService({ ref, projectId }),
    { ref: otherItem, projectId: otherItem.projectId },
  );
  await card("Mac QA Other").waitFor();
  pass(
    "manual project association works through the native IPC boundary and project editor",
  );

  // Keyboard menu and animated service details, including reduced motion.
  const trigger = page.getByRole("button", {
    name: "Actions for Mac QA Renamed",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page
      .getByRole("menuitem")
      .first()
      .evaluate((el) => getComputedStyle(el).textAlign),
    "left",
  );
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  assert.ok(await trigger.evaluate((el) => el === document.activeElement));
  const details = card("Mac QA Renamed")
    .getByRole("button", { name: "Details", exact: true })
    .first();
  const before = await details.boundingBox();
  await details.click();
  await pause(300);
  assert.ok(Math.abs((await details.boundingBox()).y - before.y) < 2);
  await details.click();
  await details.click();
  await details.click();
  await pause(300);
  assert.equal(await details.getAttribute("aria-expanded"), "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await details.focus();
  await page.keyboard.press("Space");
  assert.equal(await details.getAttribute("aria-expanded"), "true");
  await details.click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  pass(
    "left-aligned keyboard menus, stable action placement, rapid detail toggles and reduced motion",
  );

  // Real terminal opening. Only a newly created shell in our unique directory is owned.
  const beforeTerminal = new Set(
    (await inspector.snapshot()).processes.map((p) => p.pid),
  );
  await card("Mac QA Renamed")
    .getByRole("button", { name: "Open terminal", exact: true })
    .click();
  const shell = await until(
    async () => {
      const snapshot = await inspector.snapshot();
      for (const p of snapshot.processes.filter(
        (p) =>
          !beforeTerminal.has(p.pid) &&
          /\/(?:zsh|bash|fish)$/.test(p.executable),
      )) {
        try {
          const { stdout } = await runFile("/usr/sbin/lsof", [
            "-a",
            "-p",
            String(p.pid),
            "-d",
            "cwd",
            "-Fn",
          ]);
          if (stdout.split(/\r?\n/).includes(`n${mono}`)) return p;
        } catch {}
      }
    },
    Boolean,
    "Terminal did not open a shell in the correct project directory",
    15000,
  );
  owned.set(shell.pid, shell);
  await card("Mac QA Renamed")
    .getByRole("button", { name: "Open project", exact: true })
    .click();
  pass(
    "macOS Terminal opens at the exact Unicode project directory and Finder project action succeeds",
  );

  // HTTP failure/recovery is observed separately from a vanished listener.
  await fs.writeFile(path.join(web.directory, "hang"), "");
  await until(
    projects,
    (p) =>
      p.activity.some(
        (e) => e.kind === "http-unresponsive" && e.service.pid === web.pid,
      ),
    "HTTP failure was not recorded",
    25000,
  );
  assert.ok((await servers()).some((s) => s.pid === web.pid));
  await fs.unlink(path.join(web.directory, "hang"));
  await until(
    projects,
    (p) =>
      p.activity.some(
        (e) => e.kind === "http-recovered" && e.service.pid === web.pid,
      ),
    "HTTP recovery was not recorded",
    25000,
  );
  pass(
    "native HTTP failure and recovery remain distinct from listener disappearance",
  );

  const check = card("Mac QA Renamed").getByRole("checkbox", {
    name: `Select Web port ${web.port}`,
    exact: true,
  });
  await check.check();
  await search.fill("Mac QA Other");
  await watchStopFeedback();
  const selectedAt = performance.now();
  await page
    .getByRole("button", { name: "Stop Selected", exact: true })
    .click();
  await until(
    servers,
    (items) => !items.some((s) => s.pid === web.pid),
    "Selected dummy server did not stop",
    3000,
  );
  const selectedMs = performance.now() - selectedAt;
  assert.ok(selectedMs < 3000, `Selected stop took ${selectedMs.toFixed(0)}ms`);
  await verifyStopFeedback();
  assert.ok((await servers()).some((s) => s.pid === other.pid));
  assert.ok((await servers()).some((s) => s.pid === api.pid));
  await search.fill("");
  pass(
    `one-click hidden selection stop with spinner: ${selectedMs.toFixed(0)}ms; both unselected fixtures remain alive`,
  );

  await card("Mac QA Renamed")
    .getByRole("button", { name: "Restart", exact: true })
    .click();
  observations = await until(
    servers,
    (items) =>
      items.some(
        (s) =>
          s.projectId === apiItem.projectId &&
          s.port === api.port &&
          s.pid !== api.pid &&
          s.pid !== web.pid,
      ),
    "UI restart did not publish the replacement process",
    60000,
  );
  let replacement = observations.find(
    (s) =>
      s.projectId === apiItem.projectId &&
      s.port === api.port &&
      s.pid !== api.pid,
  );
  await remember(replacement.pid);
  assert.ok((await servers()).some((s) => s.pid === other.pid));
  pass(
    "native UI restart preserves project and port while leaving unrelated dummy services alive",
  );

  // Stop before closing Dashboard, while the replacement is still its child.
  await until(
    () => page.evaluate(() => window.api.getServerRestartState()),
    (s) => s.phase === "ready",
    "Restart remained busy",
  );
  const replacementStopAt = performance.now();
  await card("Mac QA Renamed")
    .getByRole("button", { name: "Stop API", exact: true })
    .click();
  await until(
    servers,
    (items) => !items.some((s) => s.pid === replacement.pid),
    "Dashboard could not stop its restarted child",
    3000,
  );
  assert.ok(performance.now() - replacementStopAt < 3000);
  pass(
    `restarted child stops while Dashboard remains open: ${(performance.now() - replacementStopAt).toFixed(0)}ms`,
  );
  const continuation = await fixture(api.directory, "API");
  observations = await until(
    servers,
    (items) => items.some((s) => s.pid === continuation.pid && s.projectId),
    "Continuation fixture not discovered",
  );
  replacement = observations.find((s) => s.pid === continuation.pid);

  await openDrawer();
  await page.getByRole("button", { name: /^Recently stopped/ }).click();
  const history = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: /^Recently stopped/ }) })
    .last();
  await history
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await history.getByText("Last status", { exact: true }).first().waitFor();
  for (const mode of ["Dark", "Light"]) {
    await closeDrawer();
    await theme(mode);
    await openDrawer();
    await drawer()
      .getByRole("button", { name: /^Recently stopped/ })
      .click();
    await history
      .getByRole("listitem")
      .first()
      .getByRole("button", { name: "Details", exact: true })
      .click();
    await history.getByText("Last status", { exact: true }).first().waitFor();
    for (const [width, height] of [
      [1100, 720],
      [900, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(...size),
        [width, height],
      );
      await page.waitForFunction((w) => innerWidth === w, width);
      await pause(100);
      await history.scrollIntoViewIfNeeded();
      await geometry(`${mode} ${width}`);
      await page.screenshot({
        path: path.join(root, `${mode.toLowerCase()}-${width}.png`),
      });
    }
  }
  await history
    .getByRole("listitem")
    .filter({ hasText: "A deliberately long project name" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, "stopped-long-name.png") });
  pass(
    "light and dark layouts at normal and minimum Mac window sizes have no horizontal control overflow",
  );

  await until(
    servers,
    (items) =>
      items.some(
        (s) =>
          s.pid === application.pid &&
          s.discovery === "application" &&
          s.canStop,
      ),
    "Native app bundle was not stoppable",
  );
  await drawer()
    .getByRole("button", { name: /^Application services/ })
    .click();
  const appStop = drawer().getByRole("button", {
    name: "Stop Mac QA Application",
    exact: true,
  });
  await appStop.scrollIntoViewIfNeeded();
  await watchStopFeedback();
  const appStoppedAt = performance.now();
  await appStop.click();
  await until(
    servers,
    (items) => !items.some((s) => s.pid === application.pid),
    "Native application listener did not stop",
    3000,
  );
  assert.ok(performance.now() - appStoppedAt < 3000);
  await verifyStopFeedback();
  assert.ok(
    !(await inspector.snapshot()).processes.some(
      (p) => p.pid === application.pid,
    ),
  );
  assert.ok((await servers()).some((s) => s.pid === other.pid));
  pass(
    `real app-bundle stop from drawer: ${(performance.now() - appStoppedAt).toFixed(0)}ms; unrelated project remains alive`,
  );
  await closeDrawer();

  await page.getByRole("button", { name: /^CLIs/ }).click();
  await page.getByRole("button", { name: "Scan Now", exact: true }).click();
  await until(
    () => page.evaluate(() => window.api.getCliScanState()),
    (s) => ["complete", "partial"].includes(s.status),
    "Manual fixture CLI scan did not complete",
  );
  assert.ok(
    (await page.evaluate(() => window.api.getCliInventory())).products.length,
  );
  await page.getByRole("button", { name: "Scan Now", exact: true }).click();
  await until(
    () => page.evaluate(() => window.api.getCliScanState()),
    (s) => ["complete", "partial"].includes(s.status),
    "Second CLI scan did not complete",
  );
  await geometry("CLI tab");
  const inventory = await page.evaluate(() => window.api.getCliInventory());
  await app.close();
  app = null;
  await launch();
  assert.equal(
    (await page.evaluate(() => window.api.getCliInventory())).revision,
    inventory.revision,
  );
  assert.ok((await projects()).recentlyStopped.some((s) => s.pid === web.pid));
  await until(
    servers,
    (items) =>
      items.some((s) => s.pid === replacement.pid) &&
      items.some((s) => s.pid === python.pid),
    "Final startup observation did not complete",
  );
  const observedHistory = (await projects()).recentlyStopped;
  assert.equal(observedHistory.filter((s) => s.pid === web.pid).length, 1);
  assert.equal(observedHistory.filter((s) => s.pid === api.pid).length, 1);
  assert.ok(
    !observedHistory.some((s) =>
      [python.pid, other.pid, replacement.pid].includes(s.pid),
    ),
    "Live services must not enter stopped history after either restart",
  );
  pass(
    "manual CLI scanning, cached inventory and stopped history persist across restart",
  );
  const projectStoppedAt = performance.now();
  await menu("Mac QA Other", "Stop This Project");
  await until(
    servers,
    (items) => !items.some((s) => s.pid === other.pid),
    "Project-scoped stop did not finish",
    3000,
  );
  await card("Mac QA Other").waitFor({ state: "hidden" });
  assert.ok(performance.now() - projectStoppedAt < 3000);
  assert.ok((await servers()).some((s) => s.pid === replacement.pid));
  assert.ok((await servers()).some((s) => s.pid === python.pid));
  pass(
    `one-click project stop removes its card: ${(performance.now() - projectStoppedAt).toFixed(0)}ms; unrelated fixtures remain alive`,
  );
  const externalAt = performance.now();
  await inspector.stop([owned.get(python.pid)], true);
  await until(
    servers,
    (items) => !items.some((s) => s.pid === python.pid),
    "Externally stopped Python listener remained visible",
    3000,
  );
  await card("Python QA").waitFor({ state: "hidden" });
  assert.ok(performance.now() - externalAt < 3000);
  pass(
    `external native Python stop disappears: ${(performance.now() - externalAt).toFixed(0)}ms`,
  );
  if (process.env.DASHBOARD_ELECTRON_EXECUTABLE) {
    await page.evaluate(() => window.api.checkForUpdates());
    const update = await until(
      () => page.evaluate(() => window.api.getUpdateStatus()),
      (state) => ["not-available", "error"].includes(state.state),
      "Packaged Sparkle update check did not finish",
    );
    assert.equal(update.state, "not-available", JSON.stringify(update));
    pass("packaged Sparkle checks the live update feed successfully");
  }
  assert.deepEqual(errors, []);
  console.log(`Native UI evidence: ${root}`);
}
main()
  .catch(async (error) => {
    console.error(error);
    if (page) {
      await page
        .screenshot({ path: path.join(root, "failure.png") })
        .catch(() => {});
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 4000),
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close().catch(() => {});
    let cleanupVerified = false;
    try {
      const snapshot = await inspector.snapshot();
      await inspector.stop(
        [...owned.values()].filter((p) =>
          snapshot.processes.some(
            (q) =>
              q.pid === p.pid &&
              q.started === p.started &&
              q.executable === p.executable,
          ),
        ),
      );
      await until(
        () => inspector.snapshot(),
        (remaining) =>
          ![...owned.values()].some((p) =>
            remaining.processes.some(
              (q) => q.pid === p.pid && q.started === p.started,
            ),
          ),
        "An owned fixture process survived cleanup",
        10000,
      );
      cleanupVerified = true;
    } catch (error) {
      console.error("Fixture cleanup:", error.message);
      process.exitCode = 1;
    }
    inspector.dispose();
    for (const child of children) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    console.log(
      `${passed.length} native UI checkpoints passed. Owned fixture cleanup ${cleanupVerified ? "verified" : "failed"}.`,
    );
  });
