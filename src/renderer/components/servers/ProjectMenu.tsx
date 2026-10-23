import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MoreHorizontal } from "lucide-react";
import type { Project } from "../../../shared/servers";
import { iconButton } from "./presentation";

export default function ProjectMenu({
  project,
  stopDisabled,
  onEdit,
  onPin,
  onBookmark,
  onActivity,
  onStop,
}: {
  project: Project;
  stopDisabled: boolean;
  onEdit(): void;
  onPin(): void;
  onBookmark(): void;
  onActivity(): void;
  onStop(): void;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const enabledItems = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) || [],
    );

  useEffect(() => {
    if (!open) return;
    const items = enabledItems();
    (focusLast.current ? items.at(-1) : items[0])?.focus();
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  const close = () => {
    trigger.current?.focus();
    setOpen(false);
  };
  const actions = [
    { label: "Edit project", run: onEdit },
    { label: project.pinned ? "Unpin" : "Pin", run: onPin },
    {
      label: project.bookmarked ? "Remove bookmark" : "Bookmark",
      run: onBookmark,
    },
    { label: "Activity", run: onActivity },
    {
      label: "Stop This Project",
      run: onStop,
      danger: true,
      disabled: stopDisabled,
    },
  ];

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        id={`${id}-trigger`}
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        className={`${iconButton} ${open ? "bg-gray-200 text-gray-900" : ""}`}
        onClick={() => {
          focusLast.current = false;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusLast.current = event.key === "ArrowUp";
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      <div
        ref={menu}
        id={`${id}-menu`}
        role="menu"
        aria-labelledby={`${id}-trigger`}
        aria-hidden={!open}
        inert={!open}
        className="absolute right-0 top-full z-30 mt-1 w-48"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "Tab") {
            close();
            if (event.shiftKey) event.preventDefault();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            const items = enabledItems();
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }
        }}
      >
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="menu"
              initial={
                reduceMotion ? false : { opacity: 0, y: -5, scale: 0.98 }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{
                opacity: 0,
                y: reduceMotion ? 0 : -3,
                scale: reduceMotion ? 1 : 0.985,
              }}
              transition={{
                duration: reduceMotion ? 0 : 0.18,
                ease: [0.22, 1, 0.36, 1],
              }}
              style={{ transformOrigin: "top right" }}
              className="rounded-xl border border-gray-300 bg-gray-100 p-1 shadow-xl"
            >
              {actions.map((action) => (
                <button
                  key={action.label}
                  role="menuitem"
                  tabIndex={-1}
                  disabled={action.disabled}
                  className={`block w-full rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 ${action.danger ? "mt-1 border-t border-gray-300/60 text-danger-text hover:bg-danger-surface focus-visible:bg-danger-surface" : "text-gray-900 hover:bg-gray-200 focus-visible:bg-gray-200"}`}
                  onClick={() => {
                    close();
                    action.run();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
