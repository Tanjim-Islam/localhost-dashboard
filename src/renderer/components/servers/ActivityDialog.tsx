import type { ActivityKind, ProjectSnapshot } from "../../../shared/servers";
import Modal from "../Modal";
import { date } from "./presentation";

const eventLabels: Record<ActivityKind, string> = {
  discovered: "Discovered",
  "listener-disappeared": "Listener disappeared",
  "http-unresponsive": "HTTP endpoint unresponsive",
  "http-recovered": "HTTP endpoint recovered",
  "process-changed": "Process identity changed",
  "port-reused": "Port reused by another process",
  restarted: "Restarted",
  "available-again": "Available again",
};
export default function ActivityDialog({
  data,
  history,
  onClose,
}: {
  data: ProjectSnapshot;
  history: string;
  onClose(): void;
}) {
  return (
    <Modal
      title={
        history === "all"
          ? "Activity"
          : `${data.projects.find((p) => p.id === history)?.name || "Project"} activity`
      }
      onClose={() => onClose()}
    >
      <ol className="divide-y divide-gray-300/40">
        {data.activity
          .filter((e) => history === "all" || e.service.projectId === history)
          .map((e) => (
            <li key={e.id} className="py-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {e.service.projectName || e.service.serviceName} · :
                  {e.service.port}
                </span>
                <time
                  className="text-xs text-gray-600"
                  dateTime={new Date(e.at).toISOString()}
                >
                  {date(e.at)}
                </time>
              </div>
              <div
                className={
                  e.kind === "http-unresponsive"
                    ? "text-danger-text"
                    : "text-gray-700"
                }
              >
                {e.service.serviceName} · {eventLabels[e.kind]}
              </div>
            </li>
          ))}
      </ol>
      {!data.activity.some(
        (e) => history === "all" || e.service.projectId === history,
      ) && <p className="text-sm text-gray-600">No activity recorded.</p>}
    </Modal>
  );
}
