import { Loader2, Play } from "lucide-react";
import type { ServiceRecord } from "../../../shared/servers";
import ProjectActions from "./ProjectActions";
import StoppedServiceRow from "./StoppedServiceRow";
import { button } from "./presentation";

export type StoppedGroup = {
  id: string;
  projectId?: string;
  name: string;
  directory?: string;
  services: ServiceRecord[];
};

// Recently stopped services, grouped under the project they belonged to.
export default function StoppedProjectGroup({
  group,
  locked,
  starting,
  onStart,
  onError,
}: {
  group: StoppedGroup;
  locked: boolean;
  starting: (service: ServiceRecord) => boolean;
  onStart(services: ServiceRecord[], projectId?: string): void;
  onError(message: string): void;
}) {
  const startable = group.services.filter((s) => s.canStart);
  const startingAll =
    startable.length > 1 && startable.every((s) => starting(s));
  return (
    <section
      aria-label={`${group.name} stopped services`}
      className="border-t border-gray-300/40 first:border-t-0"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-4">
        <h3 className="flex min-w-0 flex-1 basis-24 items-baseline gap-2 text-sm font-semibold">
          <span className="truncate" title={group.directory || group.name}>
            {group.name}
          </span>
          <span className="shrink-0 text-xs font-normal text-gray-600">
            {group.services.length}
          </span>
        </h3>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {startable.length > 1 && (
            <button
              className={`${button} inline-flex items-center gap-1.5 bg-success-surface text-success-text`}
              disabled={locked}
              onClick={() => onStart(startable, group.projectId)}
            >
              {startingAll ? (
                <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              ) : (
                <Play size={14} aria-hidden="true" />
              )}
              {startingAll ? "Starting" : "Start all"}
            </button>
          )}
          {group.directory && (
            <ProjectActions
              project={{ directory: group.directory }}
              onError={onError}
            />
          )}
        </div>
      </header>
      <ul className="divide-y divide-gray-300/40">
        {group.services.map((s) => (
          <StoppedServiceRow
            key={`${s.key}-${s.firstSeen}`}
            service={s}
            directory={group.directory}
            locked={locked}
            starting={starting(s)}
            onStart={() => onStart([s], group.projectId)}
          />
        ))}
      </ul>
    </section>
  );
}
