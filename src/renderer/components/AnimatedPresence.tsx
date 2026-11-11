import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

// Keep exiting content mounted only for its short transition. Inert prevents
// hidden controls receiving keyboard focus or accepting a second action.
export function Collapse({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && <CollapseBody key="content" id={id}>{children}</CollapseBody>}
    </AnimatePresence>
  );
}

function CollapseBody({ children, id }: { children: ReactNode; id?: string }) {
  const reduceMotion = useReducedMotion();
  const present = useIsPresent();
  return (
    <motion.div
      id={id}
      inert={!present}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeInOut" }}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  );
}

export function AnimatedTab({ children, label, className }: { children: ReactNode; label: string; className: string }) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      aria-label={label} inert={!present} aria-hidden={!present} className={className}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
    >
      {children}
    </motion.section>
  );
}

export function AnimatedDetails({ summary, children, className = "", summaryClassName = "" }: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reduceMotion = useReducedMotion();
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className={`flex w-full items-center gap-2 text-left ${summaryClassName}`}>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}>
          <ChevronDown size={14} aria-hidden="true" />
        </motion.span>
        <span>{summary}</span>
      </button>
      <Collapse open={open} id={id}>{children}</Collapse>
    </div>
  );
}

// Dialogs that are conditionally mounted must be inside AnimatePresence.
// Focus stays trapped until the exit completes, then returns to the trigger.
export function AnimatedOverlay({ children, onClose, busy = false, className }: {
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const presentRef = useRef(present);
  closeRef.current = onClose;
  busyRef.current = busy;
  presentRef.current = present;
  useEffect(() => {
    const controls = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
    if (!ref.current?.contains(document.activeElement)) controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!presentRef.current) {
        if (event.key === "Tab") event.preventDefault();
        return;
      }
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items.at(-1);
      if (!ref.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);
  return (
    <motion.div ref={ref} inert={!present} className={className}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      {children}
    </motion.div>
  );
}
