import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

export default function ServerDisclosure({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <section className="rounded-xl border border-gray-300/40">
      <button
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium outline-none transition-colors hover:bg-gray-200/50 focus-visible:ring-2 focus-visible:ring-gray-500"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {title}
        {count !== undefined && (
          <span className="font-normal text-gray-600">{count}</span>
        )}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`ml-auto transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div id={id} aria-hidden={!open} inert={!open}>
        <AnimatePresence initial={false}>
          {open && (
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
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
