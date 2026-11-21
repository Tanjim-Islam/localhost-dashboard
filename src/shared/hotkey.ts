// Settings and native registration use Electron accelerator names throughout.
const allowedHotkeyModifiers = new Set([
  "commandorcontrol",
  "command",
  "control",
  "ctrl",
  "shift",
  "alt",
  "super",
  "meta",
]);

const letterHotkeyKeys = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
);
const numberHotkeyKeys = Array.from({ length: 10 }, (_, i) => `${i}`);
const functionHotkeyKeys = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const numpadHotkeyKeys = [
  ...Array.from({ length: 10 }, (_, i) => `Num${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
];
const namedHotkeyKeys = [
  "Space",
  "Tab",
  "Enter",
  "Return",
  "Escape",
  "Esc",
  "Backspace",
  "Delete",
  "Del",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
  "Pause",
  "Break",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "MediaPlayPause",
];
const punctuationHotkeyKeys = [
  "Plus",
  "Minus",
  "Equals",
  "Equal",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "Tilde",
  ",",
  ".",
  "/",
  "\\",
  ";",
  "'",
  '"',
  "`",
  "~",
  "-",
  "=",
  "[",
  "]",
];

const allowedHotkeyKeys = new Set<string>(
  [
    ...letterHotkeyKeys,
    ...numberHotkeyKeys,
    ...functionHotkeyKeys,
    ...numpadHotkeyKeys,
    ...namedHotkeyKeys,
    ...punctuationHotkeyKeys,
  ].map((key) => key.toLowerCase()),
);

function splitHotkeyParts(hotkey: string): string[] {
  return hotkey
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isValidHotkey(hotkey: string): boolean {
  const parts = splitHotkeyParts(hotkey);
  if (parts.length < 2 || parts.length > 4) return false;
  const keyPart = parts[parts.length - 1];
  if (!keyPart) return false;
  const modifierParts = parts.slice(0, -1);
  const modifiersValid = modifierParts.every((mod) =>
    allowedHotkeyModifiers.has(mod.toLowerCase()),
  );
  if (!modifiersValid) return false;
  const keyPartNormalized = keyPart.toLowerCase();
  if (allowedHotkeyModifiers.has(keyPartNormalized)) return false;
  return allowedHotkeyKeys.has(keyPartNormalized);
}

function modifierName(key: string, platform?: string): string {
  switch (key.toLowerCase()) {
    case "commandorcontrol":
    case "cmdorctrl":
      return platform === "darwin" ? "Command" : "Control";
    case "cmd":
    case "command":
      return "Command";
    case "ctrl":
    case "control":
      return "Control";
    case "super":
    case "meta":
    case "win":
      return platform === "darwin" ? "Command" : "Super";
    case "option":
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return key;
  }
}

export function hotkeyParts(accelerator: string, platform?: string): string[] {
  return splitHotkeyParts(accelerator).map(key => modifierName(key, platform));
}

export function sameHotkey(left: string, right: string, platform?: string): boolean {
  const comparable = (accelerator: string) => {
    const parts = hotkeyParts(accelerator, platform);
    const key = parts.pop();
    return [...parts.sort(), key].join("+").toLowerCase();
  };
  return comparable(left) === comparable(right);
}

type HotkeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function recordedAccelerator(event: HotkeyEvent, platform?: string): string {
  const parts: string[] = [];
  if (event.metaKey) parts.push(modifierName("Meta", platform));
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  // Modifier-only events show the held keys while the chord is incomplete.
  if (["Meta", "Control", "Alt", "Shift", "Dead", "Unidentified"].includes(event.key)) {
    return parts.join("+");
  }
  const aliases: Record<string, string> = {
    " ": "Space", "+": "Plus", Escape: "Esc",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  };
  const key = aliases[event.key] ?? event.key;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}
