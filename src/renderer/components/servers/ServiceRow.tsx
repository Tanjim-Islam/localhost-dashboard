import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRightLeft,
  ChevronDown,
  Copy,
  Loader2,
  RotateCw,
  Square,
} from "lucide-react";
import type { ServerInfo } from "../../../shared/servers";
import type { HealthStatus } from "../../../types/preload";
import { button, iconButton, date } from "./presentation";

export default function ServiceRow({
  item,
  health,
  selected,
  locked,
  onSelect,
  onStop,
  onRestart,
  restarting,
  stopping,
  onAssign,
}: {
  item: ServerInfo;
  health?: HealthStatus;
  selected: boolean;
  locked: boolean;
  onSelect(): void;
  onStop(): void;
  onRestart?: () => void;
  restarting: boolean;
  stopping: boolean;
  onAssign(): void;
}) {
  health = health?.firstSeen === item.firstSeen ? health : undefined;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const reduceMotion = useReducedMotion();
  const application = item.discovery === "application";
  const actionable = item.discovery === "development" && !item.ignored;
  const stoppable = (actionable || application) && !item.ignored;
  const browsable =
    !application &&
    health?.endpoint !== "websocket" &&
    health?.endpoint !== "upgrade";
  const status =
    !application && health?.status === "down"
      ? "HTTP unresponsive"
      : health?.status === "slow"
        ? "Slow HTTP"
        : "Listening";
  const frameworkColor: Record<string, string> = {
    Vite: "#646CFF",
    "Next.js": "#888888",
    Nuxt: "#00DC82",
    Angular: "#DD0031",
    Astro: "#FF5D01",
  };
  return (
    <div
      className="flex min-w-0 items-start gap-3 border-l-2 px-4 py-3"
      style={{
        borderLeftColor: frameworkColor[item.framework || ""] || "transparent",
      }}
    >
      {actionable && (
        <input
          type="checkbox"
          aria-label={`Select ${item.serviceName} port ${item.port}`}
          checked={selected}
          disabled={!item.canStop || locked}
          onChange={onSelect}
          className="mt-1.5 accent-current"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-sm font-medium">{item.serviceName}</span>
          <span
            className={`text-xs ${!application && health?.status === "down" ? "text-danger-text" : health?.status === "slow" ? "text-status-conditional-text" : "text-success-text"}`}
          >
            {status}
            {health?.responseTime !== undefined
              ? ` · ${health.responseTime}ms`
              : ""}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-gray-600">
          {item.framework && item.framework !== item.serviceName && (
            <span>{item.framework}</span>
          )}
          {browsable ? (
            <button
              className="font-mono hover:underline"
              onClick={() => window.api.openUrl(item.url)}
            >
              {item.url.replace("http://", "")}
            </button>
          ) : (
            <span className="font-mono">{item.url.replace("http://", "")}</span>
          )}
          {item.cpu !== undefined && <span>{item.cpu.toFixed(1)}% CPU</span>}
          {item.memory !== undefined && (
            <span>{Math.round(item.memory / 1048576)} MB</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {browsable && (
            <button
              className={`${button} bg-gray-200`}
              onClick={() => window.api.openUrl(item.url)}
            >
              Open
            </button>
          )}
          {onRestart && item.canStop && actionable && (
            <button className={button} disabled={locked} onClick={onRestart}>
              <RotateCw
                size={13}
                className={`mr-1 inline ${restarting ? "animate-spin" : ""}`}
              />
              {restarting ? "Restarting…" : "Restart"}
            </button>
          )}
          <button
            className={iconButton}
            aria-label={copied ? "URL copied" : "Copy URL"}
            title={copied ? "Copied" : "Copy URL"}
            onClick={() => {
              window.api.copyText(item.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={14} className={copied ? "text-success-text" : ""} />
          </button>
          {stoppable && (
            <button
              className={
                "rounded-full p-2 text-danger-text hover:bg-danger-surface disabled:opacity-40"
              }
              title={
                item.canStop ? "Stop service" : "Process identity unavailable"
              }
              aria-label={`${stopping ? "Stopping" : "Stop"} ${item.serviceName}`}
              aria-busy={stopping}
              disabled={locked || !item.canStop}
              onClick={onStop}
            >
              {stopping ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Square size={14} />
              )}
            </button>
          )}
          <button
            id={`${detailsId}-trigger`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-gray-600 outline-none transition-colors duration-150 hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500 motion-reduce:transition-none"
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
        <div id={detailsId} aria-hidden={!expanded} inert={!expanded}>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                key="details"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.22,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="overflow-hidden"
              >
                <div className="pt-3">
                  <div className="rounded-lg border border-gray-300/50 bg-gray-200/40 px-3 py-2.5">
                    <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-5 gap-y-2 text-xs">
                      <div className="min-w-0">
                        <dt className="text-gray-600">Process</dt>
                        <dd className="mt-1 break-all font-mono text-gray-900">
                          {item.processName || "Unknown process"}
                          <span className="ml-2 whitespace-nowrap font-sans text-gray-600">
                            PID {item.pid}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-gray-600">First observed</dt>
                        <dd className="mt-1 text-gray-900">
                          {date(item.firstSeen)}
                        </dd>
                      </div>
                    </dl>
                    {item.application && (
                      <div className="mt-2 break-all font-mono text-xs text-gray-600">
                        {item.application.executable}
                      </div>
                    )}
                    {health?.httpStatus && (
                      <div className="mt-2 text-xs text-gray-600">
                        HTTP {health.httpStatus}
                        {health.endpoint === "websocket"
                          ? " · WebSocket"
                          : health.endpoint === "upgrade"
                            ? " · Upgrade required"
                            : ""}
                      </div>
                    )}
                    {!application && (
                      <button
                        className="-ml-1.5 mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-gray-700 outline-none transition-colors duration-150 hover:bg-gray-300/60 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500 motion-reduce:transition-none disabled:opacity-40"
                        disabled={item.pid <= 0}
                        onClick={onAssign}
                      >
                        <ArrowRightLeft size={12} aria-hidden="true" />
                        Change project
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
