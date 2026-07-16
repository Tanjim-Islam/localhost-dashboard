// Shared destructive action styling for the Windows and macOS script cards.
import type { ButtonHTMLAttributes } from "react";
import cx from "classnames";

type ScriptDestructiveButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function ScriptDestructiveButton({
  className,
  type = "button",
  ...props
}: ScriptDestructiveButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-mimi_pink-300 text-mimi_pink-100 transition-all duration-200",
        "hover:scale-[1.02] hover:bg-mimi_pink-300 hover:text-mimi_pink-100 hover:ring-2 hover:ring-mimi_pink-400/25",
        "active:scale-95 active:bg-mimi_pink-300 active:text-mimi_pink-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mimi_pink-400/45 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-100",
        "disabled:cursor-not-allowed disabled:bg-mimi_pink-300 disabled:text-mimi_pink-100 disabled:hover:scale-100 disabled:hover:ring-0 disabled:active:scale-100",
        className,
      )}
      {...props}
    />
  );
}
