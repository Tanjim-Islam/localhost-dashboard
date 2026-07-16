import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type EnvironmentVariableSummary = Awaited<
  ReturnType<typeof window.api.getEnvironmentKeys>
>[number];
type EnvironmentVariableScope = EnvironmentVariableSummary["scope"];
type SaveEnvironmentVariableInput = Parameters<
  typeof window.api.saveEnvironmentKey
>[0];

type Props = {
  active: boolean;
  query: string;
  onCountChange: (count: number) => void;
};

type ScopeFilter = "all" | EnvironmentVariableScope;

export default function EnvironmentKeysTab({
  active,
  query,
  onCountChange,
}: Props) {
  const [items, setItems] = useState<EnvironmentVariableSummary[]>([]);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorItem, setEditorItem] = useState<
    EnvironmentVariableSummary | null | undefined
  >(undefined);
  const [deleteItem, setDeleteItem] =
    useState<EnvironmentVariableSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadItems = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const next = await window.api.getEnvironmentKeys();
      setItems(next);
      setError(null);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (!active) return;
    const handleFocus = () => void loadItems();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [active, loadItems]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const searchedItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) =>
      [item.name, item.scope, item.sessionStatus]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [items, query]);

  const filteredItems = useMemo(
    () =>
      scopeFilter === "all"
        ? searchedItems
        : searchedItems.filter((item) => item.scope === scopeFilter),
    [scopeFilter, searchedItems],
  );

  useEffect(() => {
    onCountChange(searchedItems.length);
  }, [onCountChange, searchedItems.length]);

  const userCount = items.filter((item) => item.scope === "user").length;
  const machineCount = items.length - userCount;

  const saveItem = async (input: SaveEnvironmentVariableInput) => {
    const next = await window.api.saveEnvironmentKey(input);
    setItems(next);
    setEditorItem(undefined);
    setNotice(`${input.name} saved to Windows.`);
  };

  const removeItem = async (item: EnvironmentVariableSummary) => {
    const next = await window.api.deleteEnvironmentKey({
      name: item.name,
      scope: item.scope,
    });
    setItems(next);
    setDeleteItem(null);
    setNotice(`${item.name} deleted from Windows.`);
  };

  if (!active) return null;

  return (
    <section className="space-y-5" aria-label="Windows environment keys">
      <div className="app-card relative overflow-hidden rounded-2xl border border-gray-300 bg-gray-100/94 px-5 py-5 shadow-soft">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-gradient-to-l from-night-600/20 to-transparent" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-celadon-400/25 bg-celadon-300/10 text-celadon-500">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900">
                  Global ENV Keys
                </h2>
                <span className="rounded-full border border-gray-300 bg-gray-200 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-700">
                  Windows
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadItems(true)}
              disabled={refreshing}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-gray-300 bg-gray-200 px-3.5 text-sm font-medium text-gray-800 transition-all hover:border-gray-400 hover:bg-gray-300 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setEditorItem(null)}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-celadon-400 px-4 text-sm font-semibold text-night-100 transition-all hover:bg-celadon-500 active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              Add key
            </button>
          </div>
        </div>

        <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-300/80 pt-4">
          <div className="flex items-center rounded-full border border-gray-300 bg-gray-200/80 p-1">
            <ScopeButton
              active={scopeFilter === "all"}
              label="All"
              count={items.length}
              onClick={() => setScopeFilter("all")}
            />
            <ScopeButton
              active={scopeFilter === "user"}
              label="User"
              count={userCount}
              onClick={() => setScopeFilter("user")}
            />
            <ScopeButton
              active={scopeFilter === "machine"}
              label="System"
              count={machineCount}
              onClick={() => setScopeFilter("machine")}
            />
          </div>
        </div>
      </div>

      {notice && (
        <div className="env-status-enter flex items-center gap-2 rounded-xl border border-celadon-400/30 bg-celadon-300/10 px-4 py-3 text-sm text-celadon-600">
          <Check className="h-4 w-4" />
          {notice}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-mimi_pink-400/35 bg-mimi_pink-300/10 px-4 py-3 text-sm text-mimi_pink-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Could not load ENV keys</div>
            <div className="mt-0.5 text-mimi_pink-500/80">{error}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-gray-300 bg-gray-200/50 text-sm text-gray-600">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Reading Windows environment variables
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-200/35 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-200 text-gray-600">
            <KeyRound className="h-5 w-5" />
          </div>
          <div className="mt-4 text-sm font-semibold text-gray-800">
            {query.trim() || scopeFilter !== "all"
              ? "No matching ENV keys"
              : "No secret-like ENV keys found"}
          </div>
          <div className="mt-1 max-w-md text-xs leading-5 text-gray-600">
            Keys with names containing KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL,
            or PAT appear here.
          </div>
        </div>
      ) : (
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
          }}
        >
          {filteredItems.map((item) => (
            <EnvironmentKeyCard
              key={item.id}
              item={item}
              onEdit={() => setEditorItem(item)}
              onDelete={() => setDeleteItem(item)}
            />
          ))}
        </div>
      )}

      {editorItem !== undefined && (
        <EnvironmentKeyEditor
          item={editorItem}
          onClose={() => setEditorItem(undefined)}
          onSave={saveItem}
        />
      )}

      {deleteItem && (
        <DeleteEnvironmentKeyDialog
          item={deleteItem}
          onClose={() => setDeleteItem(null)}
          onDelete={() => removeItem(deleteItem)}
        />
      )}
    </section>
  );
}

function ScopeButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
        active
          ? "bg-gray-400 text-gray-900 shadow-sm"
          : "text-gray-600 hover:text-gray-900"
      }`}
    >
      {label} <span className="ml-1 opacity-70">{count}</span>
    </button>
  );
}

function EnvironmentKeyCard({
  item,
  onEdit,
  onDelete,
}: {
  item: EnvironmentVariableSummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [copiedReference, setCopiedReference] = useState<
    "name" | "usage" | null
  >(null);
  const hideTimer = useRef<number | null>(null);

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  useEffect(() => clearHideTimer, []);

  const loadValue = async (): Promise<string> => {
    if (revealedValue !== null) return revealedValue;
    return window.api.getEnvironmentKeyValue({
      name: item.name,
      scope: item.scope,
    });
  };

  const toggleReveal = async () => {
    if (revealedValue !== null) {
      clearHideTimer();
      setRevealedValue(null);
      return;
    }

    setRevealing(true);
    setValueError(null);
    try {
      const value = await loadValue();
      setRevealedValue(value);
      hideTimer.current = window.setTimeout(() => {
        setRevealedValue(null);
        hideTimer.current = null;
      }, 15_000);
    } catch (nextError) {
      setValueError(formatError(nextError));
    } finally {
      setRevealing(false);
    }
  };

  const copyValue = async () => {
    setValueError(null);
    try {
      const value = await loadValue();
      window.api.copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (nextError) {
      setValueError(formatError(nextError));
    }
  };

  const copyReference = (kind: "name" | "usage") => {
    const text = kind === "name" ? item.name : `%${item.name}%`;
    window.api.copyText(text);
    setCopiedReference(kind);
    setCopyMenuOpen(false);
    window.setTimeout(() => setCopiedReference(null), 1400);
  };

  const maskLength = Math.min(Math.max(item.valueLength, 8), 24);
  const maskedValue = `${"*".repeat(maskLength)}${
    item.valueLength > 24 ? "..." : ""
  }`;

  return (
    <article className="app-card group relative overflow-hidden rounded-2xl border border-gray-300 bg-gray-200/75 p-5 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-400">
      <div className="absolute inset-y-0 left-0 w-1 bg-celadon-400/80" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-mono text-sm font-semibold tracking-wide text-gray-900">
              {item.name}
            </h3>
            <ScopeBadge scope={item.scope} />
          </div>
          <SessionBadge status={item.sessionStatus} />
        </div>
        <div className="flex items-center gap-1">
          <div
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setCopyMenuOpen(false);
              }
            }}
          >
            <IconButton
              label={
                copiedReference
                  ? "Reference copied"
                  : "Copy variable name or reference"
              }
              onClick={() => setCopyMenuOpen((open) => !open)}
            >
              {copiedReference ? (
                <Check className="h-3.5 w-3.5 text-celadon-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </IconButton>
            {copyMenuOpen && (
              <div className="env-status-enter absolute right-0 top-10 z-20 w-56 rounded-xl border border-gray-300 bg-gray-100 p-1.5 shadow-soft">
                <button
                  type="button"
                  onClick={() => copyReference("name")}
                  className="w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-gray-200"
                >
                  <span className="block text-xs font-semibold text-gray-800">
                    Copy variable name
                  </span>
                  <code className="mt-0.5 block truncate text-[11px] text-gray-600">
                    {item.name}
                  </code>
                </button>
                <button
                  type="button"
                  onClick={() => copyReference("usage")}
                  className="w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-gray-200"
                >
                  <span className="block text-xs font-semibold text-gray-800">
                    Copy Windows reference
                  </span>
                  <code className="mt-0.5 block truncate text-[11px] text-gray-600">
                    %{item.name}%
                  </code>
                </button>
              </div>
            )}
          </div>
          <IconButton label={`Edit ${item.name}`} onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label={`Delete ${item.name}`} onClick={onDelete} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-gray-300 bg-gray-100/80 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-600">
            Stored value
          </span>
          <span className="text-[11px] text-gray-500">
            {item.valueLength} character{item.valueLength === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`min-w-0 flex-1 truncate font-mono text-sm tracking-[0.1em] ${
              revealedValue !== null
                ? "select-text tracking-normal text-gray-900"
                : "text-gray-700"
            }`}
            aria-live="polite"
          >
            {revealedValue ?? maskedValue}
          </div>
          <IconButton
            label={revealedValue === null ? "Reveal value" : "Hide value"}
            onClick={() => void toggleReveal()}
            disabled={revealing}
          >
            {revealing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : revealedValue === null ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
          </IconButton>
          <IconButton
            label={copied ? "Value copied" : "Copy value"}
            onClick={() => void copyValue()}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-celadon-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </div>
      </div>

      {valueError && (
        <div className="mt-2 text-xs text-mimi_pink-500">{valueError}</div>
      )}
    </article>
  );
}

function EnvironmentKeyEditor({
  item,
  onClose,
  onSave,
}: {
  item: EnvironmentVariableSummary | null;
  onClose: () => void;
  onSave: (input: SaveEnvironmentVariableInput) => Promise<void>;
}) {
  const isEditing = item !== null;
  const [name, setName] = useState(item?.name ?? "");
  const [scope, setScope] = useState<EnvironmentVariableScope>(
    item?.scope ?? "user",
  );
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [loadingValue, setLoadingValue] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    window.api
      .getEnvironmentKeyValue({ name: item.name, scope: item.scope })
      .then((nextValue) => {
        if (!cancelled) setValue(nextValue);
      })
      .catch((nextError) => {
        if (!cancelled) setError(formatError(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingValue(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const normalizedName = name.trim().toUpperCase();
      await onSave({
        name: normalizedName,
        scope,
        value,
        ...(item ? { original: { name: item.name, scope: item.scope } } : {}),
      });
    } catch (nextError) {
      setError(formatError(nextError));
      setSaving(false);
    }
  };

  return (
    <div
      className="env-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 no-drag"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="app-dialog env-modal-panel w-full max-w-[520px] rounded-2xl border border-gray-300 bg-gray-100 p-5 text-gray-900 shadow-soft"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-key-editor-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-celadon-300/10 text-celadon-500">
              {isEditing ? (
                <Pencil className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </div>
            <div>
              <h2
                id="environment-key-editor-title"
                className="text-base font-semibold"
              >
                {isEditing ? "Edit ENV key" : "Add ENV key"}
              </h2>
              <p className="mt-0.5 text-xs text-gray-600">
                Changes are written directly to Windows.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close editor"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-gray-700 transition-colors hover:bg-mimi_pink-300 hover:text-mimi_pink-900 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-gray-600">
              Variable name
            </span>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value.toUpperCase())}
                placeholder="GITHUB_TOKEN"
                spellCheck={false}
                maxLength={128}
                className="w-full rounded-xl border border-gray-300 bg-gray-200 py-2.5 pl-10 pr-3 font-mono text-sm text-gray-900 outline-none transition focus:border-celadon-400 focus:ring-2 focus:ring-celadon-400/15"
              />
            </div>
            <span className="mt-1.5 block text-xs text-gray-500">
              Use letters, numbers, and underscores. The name must identify a
              key, token, secret, password, credential, or PAT.
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-gray-600">
              Stored value
            </span>
            <div className="relative">
              <input
                type={showValue ? "text" : "password"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={loadingValue}
                placeholder={
                  loadingValue ? "Loading value" : "Enter secret value"
                }
                autoComplete="new-password"
                spellCheck={false}
                maxLength={8192}
                className="w-full rounded-xl border border-gray-300 bg-gray-200 py-2.5 pl-3 pr-11 font-mono text-sm text-gray-900 outline-none transition focus:border-celadon-400 focus:ring-2 focus:ring-celadon-400/15 disabled:cursor-wait disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setShowValue((visible) => !visible)}
                disabled={loadingValue}
                aria-label={showValue ? "Hide value" : "Reveal value"}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-300 hover:text-gray-900 disabled:opacity-40"
              >
                {loadingValue ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : showValue ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-gray-600">
              Scope
            </span>
            <div className="grid grid-cols-2 gap-2">
              <ScopeChoice
                active={scope === "user"}
                title="Your account"
                description="Recommended"
                icon={<User className="h-4 w-4" />}
                onClick={() => setScope("user")}
              />
              <ScopeChoice
                active={scope === "machine"}
                title="Entire PC"
                description="Admin may be required"
                icon={<Monitor className="h-4 w-4" />}
                onClick={() => setScope("machine")}
              />
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-gray-300 bg-gray-200/75 px-3 py-2.5 text-xs leading-5 text-gray-600">
            <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-celadon-400" />
            Running apps may keep the previous value. Restart those apps after
            saving.
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-mimi_pink-400/30 bg-mimi_pink-300/10 px-3 py-2.5 text-xs text-mimi_pink-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-gray-300 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 rounded-full bg-gray-200 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-300 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || loadingValue || !name.trim() || !value.length}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-celadon-400 px-4 text-sm font-semibold text-night-100 transition hover:bg-celadon-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving" : isEditing ? "Save changes" : "Create key"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteEnvironmentKeyDialog({
  item,
  onClose,
  onDelete,
}: {
  item: EnvironmentVariableSummary;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (nextError) {
      setError(formatError(nextError));
      setDeleting(false);
    }
  };

  return (
    <div
      className="env-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 no-drag"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onClose();
      }}
    >
      <div
        className="app-dialog env-modal-panel w-full max-w-[430px] rounded-2xl border border-gray-300 bg-gray-100 p-5 text-gray-900 shadow-soft"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-environment-key-title"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mimi_pink-300/15 text-mimi_pink-400">
          <Trash2 className="h-5 w-5" />
        </div>
        <h2
          id="delete-environment-key-title"
          className="mt-4 text-base font-semibold"
        >
          Delete this ENV key permanently?
        </h2>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          <span className="font-mono font-semibold text-gray-900">
            {item.name}
          </span>{" "}
          will be removed from Windows. Running apps may keep their current copy
          until they close.
        </p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-mimi_pink-400/30 bg-mimi_pink-300/10 px-3 py-2.5 text-xs text-mimi_pink-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2 border-t border-gray-300 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="h-9 rounded-full bg-gray-200 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-300 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={deleting}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-mimi_pink-300 px-4 text-sm font-semibold text-mimi_pink-900 transition hover:bg-mimi_pink-400 active:scale-[0.98] disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {deleting ? "Deleting" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeChoice({
  active,
  title,
  description,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${
        active
          ? "border-celadon-400/60 bg-celadon-300/10"
          : "border-gray-300 bg-gray-200 hover:border-gray-400"
      }`}
    >
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-lg ${
          active ? "bg-celadon-400 text-night-100" : "bg-gray-300 text-gray-700"
        }`}
      >
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold text-gray-900">
          {title}
        </span>
        <span className="block text-[11px] text-gray-600">{description}</span>
      </span>
    </button>
  );
}

function ScopeBadge({ scope }: { scope: EnvironmentVariableScope }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-100/70 px-2 py-0.5 text-[11px] font-medium text-gray-600">
      {scope === "user" ? (
        <User className="h-3 w-3" />
      ) : (
        <Monitor className="h-3 w-3" />
      )}
      {scope === "user" ? "User" : "System"}
    </span>
  );
}

function SessionBadge({
  status,
}: {
  status: EnvironmentVariableSummary["sessionStatus"];
}) {
  if (status === "active") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-celadon-400">
        <Check className="h-3.5 w-3.5" />
        Active in this app session
      </div>
    );
  }
  if (status === "shadowed") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-pale_dogwood-400">
        <Layers className="h-3.5 w-3.5" />
        Overridden by a user value
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-600">
      <RotateCcw className="h-3.5 w-3.5" />
      Restart apps to use this value
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-full border transition-all disabled:cursor-wait disabled:opacity-50 ${
        danger
          ? "border-mimi_pink-400/20 bg-mimi_pink-300/10 text-mimi_pink-400 hover:bg-mimi_pink-300/25"
          : "border-gray-300 bg-gray-100/70 text-gray-600 hover:border-gray-400 hover:bg-gray-300 hover:text-gray-900"
      }`}
    >
      {children}
    </button>
  );
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}
