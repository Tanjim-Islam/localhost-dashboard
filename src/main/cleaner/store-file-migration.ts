import fs from "node:fs";
import path from "node:path";
import { migrateCleanerStore } from "./store-migration";

const CLEANER_STORE_FILE = "cleaner.json";
const MAX_AUDIT_BACKUPS = 3;

export function prepareCleanerStoreForAuditMigration(
  userDataPath: string,
): void {
  const storePath = path.join(userDataPath, CLEANER_STORE_FILE);
  if (!fs.existsSync(storePath)) return;

  const raw = fs.readFileSync(storePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    preserveCleanerStoreBackup(storePath, raw);
    throw new Error(
      "Cleaner audit storage is invalid. A backup was preserved and the store was not reset.",
    );
  }
  const sourceVersion =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["schemaVersion"]
      : undefined;
  const migrated = migrateCleanerStore(parsed);
  if (
    sourceVersion === 3 &&
    JSON.stringify(migrated) === JSON.stringify(parsed)
  ) {
    return;
  }

  const backupName = preserveCleanerStoreBackup(storePath, raw);
  migrated.migrationNotices = [
    `Cleaner audit storage was migrated to schema 3. The previous bounded representation was preserved as ${backupName}.`,
    ...migrated.migrationNotices,
  ].slice(0, 20);
  writeJsonAtomically(storePath, migrated);
}

function preserveCleanerStoreBackup(storePath: string, raw: string): string {
  const directory = path.dirname(storePath);
  const backupName = `cleaner.audit-backup.${Date.now()}.json`;
  const backupPath = path.join(directory, backupName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(backupPath, raw, { encoding: "utf8", flag: "wx" });

  const backups = fs
    .readdirSync(directory)
    .filter((name) => /^cleaner\.audit-backup\.\d+\.json$/.test(name))
    .sort()
    .reverse();
  for (const stale of backups.slice(MAX_AUDIT_BACKUPS)) {
    fs.rmSync(path.join(directory, stale), { force: false });
  }
  return backupName;
}

function writeJsonAtomically(targetPath: string, value: unknown): void {
  const temporaryPath = `${targetPath}.migration-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  fs.renameSync(temporaryPath, targetPath);
}
