import si from "systeminformation";
import pidusage from "pidusage";

type ProcessSnapshot = Awaited<ReturnType<typeof si.processes>>;
type ProcessMetrics = Pick<pidusage.Status, "cpu" | "memory">;
type MetricsReader = (pids: number[]) => Promise<Record<string, ProcessMetrics>>;

// Server and AHK scans start together. Share only an outstanding observation,
// never a completed snapshot, so a manual refresh always reads current data.
export function createProcessSnapshotReader(
  read: () => Promise<ProcessSnapshot> = () => si.processes(),
): () => Promise<ProcessSnapshot> {
  let pending: Promise<ProcessSnapshot> | undefined;
  return () => {
    if (!pending) {
      // Keep sharing the actual query even if a caller stops waiting. The
      // library cannot cancel its native child, so clearing on a caller timeout
      // would start additional process enumerations while this one still runs.
      pending = read().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

export const readProcessSnapshot = createProcessSnapshotReader();

// pidusage supports one OS query for several PIDs. Sample a process once even
// when it exposes several ports. Keep each command bounded on Windows.
export async function sampleProcessMetrics(
  pids: Iterable<number>,
  read: MetricsReader = (batch) => pidusage(batch),
): Promise<Map<number, ProcessMetrics>> {
  const unique = [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  const result = new Map<number, ProcessMetrics>();
  const collect = (batch: number[], metrics: Record<string, ProcessMetrics>) => {
    for (const pid of batch) {
      const usage = metrics[pid];
      if (usage && Number.isFinite(usage.cpu) && Number.isFinite(usage.memory))
        result.set(pid, usage);
    }
  };
  for (let offset = 0; offset < unique.length; offset += 128) {
    const batch = unique.slice(offset, offset + 128);
    try {
      collect(batch, await read(batch));
    } catch {
      // Some platform backends reject a whole batch when one process exits.
      // Preserve metrics for the survivors without failing discovery.
      if (batch.length === 1) continue;
      for (const pid of batch) {
        try {
          collect([pid], await read([pid]));
        } catch {
          // Optional metrics must not turn an observation into a failure.
        }
      }
    }
  }
  return result;
}
