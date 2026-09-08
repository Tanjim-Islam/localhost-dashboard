// Run after npm run test:clis:compile. Uses production discovery without the app store.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CliScanner } = require("../.tmp-tests/src/main/clis/scanner.js");
const {
  CliCancellationToken,
} = require("../.tmp-tests/src/main/clis/session.js");
const {
  RealCliCommandRunner,
} = require("../.tmp-tests/src/main/clis/command-runner.js");

async function main() {
  const output = path.resolve(process.argv[2] || ".tmp-tests/cli-audit.json");
  const previous = process.argv[3]
    ? JSON.parse(await fs.readFile(process.argv[3], "utf8"))
    : null;
  const neutralWorkingDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cli-audit-"),
  );
  await fs.writeFile(
    path.join(neutralWorkingDirectory, "package.json"),
    '{"private":true}\n',
  );
  const runner = new RealCliCommandRunner(neutralWorkingDirectory);
  const scanner = new CliScanner({
    runner,
    clock: { now: () => Date.now() },
    createEnvironment: async () => ({
      platform: process.platform,
      architecture: process.arch,
      env: { ...process.env },
      homeDirectory: os.homedir(),
      pathValue: process.env.PATH || "",
      pathExtValue: process.env.PATHEXT || ".EXE;.CMD;.BAT;.PS1",
      knownDirectories: [],
      neutralWorkingDirectory,
      testMode: false,
    }),
  });
  let stage;
  const inventory = await scanner.scan({
    previous,
    cancellation: new CliCancellationToken(),
    scanSessionId: "read-only-audit",
    onProgress: (progress) => {
      if (stage !== progress.stage) console.log(progress.label);
      stage = progress.stage;
    },
  });
  if (inventory.completeness === "complete")
    inventory.lastSuccessfulScanAt = inventory.generatedAt;
  await fs.writeFile(output, JSON.stringify(inventory, null, 2));
  const current = inventory.installations.filter(
    (item) => item.presence === "present",
  );
  console.log(
    JSON.stringify(
      {
        output,
        products: inventory.products.length,
        installations: current.length,
        packageOwned: current.filter((item) => item.packageIdentity).length,
        embedded: current.filter((item) =>
          ["application-embedded", "sdk-bundled"].includes(item.origin),
        ).length,
        sources: inventory.sourceResults.map(
          ({ label, status, recordCount, errorCode }) => ({
            label,
            status,
            recordCount,
            errorCode,
          }),
        ),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
