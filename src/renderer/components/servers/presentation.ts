export const button =
  "rounded-full px-3 py-1.5 text-sm outline-none transition-colors duration-150 hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-gray-500 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed";
export const iconButton =
  "rounded-full p-2 text-gray-600 outline-none transition-colors duration-150 hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500 motion-reduce:transition-none disabled:opacity-40";
export const input =
  "w-full rounded-lg border border-gray-300 bg-gray-200 px-3 py-2 text-sm text-gray-900";
export const date = (at: number) =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
