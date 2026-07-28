import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";

export function CliSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <div className="min-w-[142px] flex-1">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="h-9 bg-gray-200/65"
          aria-label={`${label}: ${selected?.label ?? value}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
              {label}
            </span>
            <span className="truncate text-sm font-medium">
              {selected?.label ?? value}
            </span>
          </span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-[190px]">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
