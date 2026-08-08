import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import {
  CLEANER_STATUS_META,
  CLEANER_TONE_STYLES,
  type CleanerVisualStatus,
} from "../../cleaner-semantics";
import { CleanerStatusIcon } from "./CleanerStatus";

export type CleanerSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  status?: CleanerVisualStatus;
};

export function CleanerSelect({
  label,
  value,
  onChange,
  options,
  className = "w-[180px]",
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: CleanerSelectOption[];
  className?: string;
}) {
  const selected =
    options.find((option) => option.value === value) ?? options[0];
  return (
    <div className={className}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          aria-label={`${label}: ${selected?.label ?? value}`}
          className="h-9 bg-gray-200/66"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
              {label}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-gray-900">
              {selected?.label ?? value}
            </span>
          </span>
        </SelectTrigger>
        <SelectContent sideOffset={8} align="start" className="min-w-[220px]">
          {options.map((option) => {
            const meta = option.status
              ? CLEANER_STATUS_META[option.status]
              : null;
            const tone = meta ? CLEANER_TONE_STYLES[meta.tone] : null;
            return (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg ${tone ? `${tone.surface} ${tone.icon}` : "bg-gray-200 text-gray-700"}`}
                  >
                    {meta ? (
                      <CleanerStatusIcon
                        name={meta.icon}
                        className="h-3.5 w-3.5"
                      />
                    ) : (
                      (option.icon ?? (
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                      ))
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-900">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-[10px] leading-4 text-gray-600">
                        {option.description}
                      </span>
                    )}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
