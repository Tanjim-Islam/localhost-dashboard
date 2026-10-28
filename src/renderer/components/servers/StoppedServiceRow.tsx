import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Loader2, Play } from "lucide-react";
import type { ServiceRecord } from "../../../shared/servers";
import { button, date } from "./presentation";

// Rows render inside a project group, so the service name leads.
export default function StoppedServiceRow({
  service,
  directory,
  locked,
  starting,
  onStart,
}: {
  service: ServiceRecord;
  directory?: string;
  locked: boolean;
  starting: boolean;
  onStart(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const reduced = useReducedMotion();
  const stoppedAt = service.stoppedAt || service.lastSeen;
  const processStarted = Date.parse(service.processStarted || "");

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="min-w-0 flex-1 basis-28">
          <div className="flex min-w-0 items-baseline gap-2 text-sm leading-5">
            <span className="truncate font-medium" title={service.serviceName}>
              {service.serviceName}
            </span>
            <span className="shrink-0 font-mono text-xs text-gray-600">
              :{service.port}
            </span>
          </div>
          <time
            dateTime={new Date(stoppedAt).toISOString()}
            aria-label={`Listener disappeared ${date(stoppedAt)}`}
            className="mt-1.5 block text-xs leading-5 text-gray-600"
          >
            {date(stoppedAt)}
          </time>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            className={`${button} inline-flex items-center gap-1.5 bg-success-surface text-success-text`}
            disabled={locked || !service.canStart}
            title={
              service.canStart
                ? undefined
                : "Launch details were not captured in this session. Start it from its terminal."
            }
            onClick={onStart}
          >
            {starting ? (
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            {starting ? "Starting" : "Start"}
          </button>
          <button
            id={`${id}-trigger`}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-gray-600 outline-none transition-colors duration-150 hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500 motion-reduce:transition-none"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            Details
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>
      <div id={id} aria-hidden={!expanded} inert={!expanded}>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={reduced ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                duration: reduced ? 0 : 0.22,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="overflow-hidden"
            >
              <div className="pt-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-gray-200/40 p-3 text-xs leading-5 sm:grid-cols-3 xl:grid-cols-5">
                  <div className="min-w-0">
                    <dt className="text-gray-600">Process</dt>
                    <dd className="mt-1 break-all font-mono">
                      {service.processName || "Unknown process"}
                      <span className="ml-2 whitespace-nowrap font-sans text-gray-600">
                        PID {service.pid}
                      </span>
                    </dd>
                  </div>
                  {service.framework && (
                    <div>
                      <dt className="text-gray-600">Runtime</dt>
                      <dd className="mt-1">{service.framework}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-gray-600">Last observed</dt>
                    <dd className="mt-1">{date(service.lastSeen)}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-600">Last status</dt>
                    <dd className="mt-1">
                      {service.lastStatus === "http-unresponsive"
                        ? "HTTP unresponsive"
                        : "Listening"}
                    </dd>
                  </div>
                  {service.processStarted && (
                    <div className="min-w-0">
                      <dt className="text-gray-600">Process started</dt>
                      <dd className="mt-1 break-words">
                        {Number.isFinite(processStarted)
                          ? date(processStarted)
                          : service.processStarted}
                      </dd>
                    </div>
                  )}
                  {directory && (
                    <div className="col-span-full min-w-0">
                      <dt className="text-gray-600">Project folder</dt>
                      <dd className="mt-1 break-all font-mono">{directory}</dd>
                    </div>
                  )}
                </dl>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}
