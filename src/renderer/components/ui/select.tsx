// Shared Shadcn-style Select primitive for renderer settings controls.
import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import cx from "classnames";
import { motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

type SelectMotionContextValue = {
  closing: boolean;
  finishClose: () => void;
};

const SelectMotionContext = createContext<SelectMotionContextValue | null>(
  null,
);

type SelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>,
  "open" | "defaultOpen"
>;

function Select({ children, onOpenChange, ...props }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setClosing(false);
        setOpen(true);
        onOpenChange?.(true);
        return;
      }

      if (open) setClosing(true);
    },
    [onOpenChange, open],
  );

  const finishClose = useCallback(() => {
    if (!closing) return;
    setClosing(false);
    setOpen(false);
    onOpenChange?.(false);
  }, [closing, onOpenChange]);

  const motionValue = useMemo(
    () => ({ closing, finishClose }),
    [closing, finishClose],
  );

  return (
    <SelectMotionContext.Provider value={motionValue}>
      <SelectPrimitive.Root
        {...props}
        open={open}
        onOpenChange={handleOpenChange}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectMotionContext.Provider>
  );
}

const SelectTrigger = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cx(
      "flex h-10 w-full items-center justify-between gap-3 rounded-xl border border-gray-300 bg-gray-100/70 px-3 text-left text-xs text-gray-900 outline-none transition-colors hover:border-gray-400 hover:bg-gray-200/65 focus-visible:border-night-700 focus-visible:ring-2 focus-visible:ring-night-700/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-night-700 data-[state=open]:ring-2 data-[state=open]:ring-night-700/15",
      className,
    )}
    {...props}
  >
    <span className="min-w-0 flex-1">{children}</span>
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-600" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(
  (
    {
      className,
      children,
      position = "popper",
      sideOffset = 6,
      collisionPadding = 12,
      ...props
    },
    ref,
  ) => {
    const motionContext = useContext(SelectMotionContext);
    const reduceMotion = useReducedMotion();

    if (!motionContext) {
      throw new Error("SelectContent must be used inside Select");
    }

    const { closing, finishClose } = motionContext;
    const duration = reduceMotion ? 0 : closing ? 0.11 : 0.16;

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          ref={ref}
          position={position}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className="z-[100] outline-none"
          {...props}
        >
          <motion.div
            className={cx(
              "min-w-[8rem] overflow-hidden rounded-xl border border-gray-300 bg-gray-100 text-gray-900 shadow-soft",
              className,
            )}
            initial={reduceMotion ? false : { opacity: 0, y: -4, scale: 0.985 }}
            animate={
              closing
                ? { opacity: 0, y: -3, scale: 0.99 }
                : { opacity: 1, y: 0, scale: 1 }
            }
            transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
            onAnimationComplete={() => {
              if (closing) finishClose();
            }}
            style={{
              maxHeight:
                "min(280px, var(--radix-select-content-available-height))",
              transformOrigin: "var(--radix-select-content-transform-origin)",
            }}
          >
            <SelectScrollUpButton />
            <SelectPrimitive.Viewport className="w-full min-w-[var(--radix-select-trigger-width)] p-1">
              {children}
            </SelectPrimitive.Viewport>
            <SelectScrollDownButton />
          </motion.div>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cx(
      "relative flex w-full cursor-default select-none items-center rounded-lg py-2 pl-2.5 pr-8 text-xs text-gray-800 outline-none transition-colors focus:bg-gray-200 focus:text-gray-900 data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-2 flex h-4 w-4 items-center justify-center text-gray-900">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectScrollUpButton = forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cx(
      "flex h-6 cursor-default items-center justify-center bg-gray-100 text-gray-600",
      className,
    )}
    {...props}
  >
    <ChevronUp className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cx(
      "flex h-6 cursor-default items-center justify-center bg-gray-100 text-gray-600",
      className,
    )}
    {...props}
  >
    <ChevronDown className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName;

export { Select, SelectContent, SelectItem, SelectTrigger };
