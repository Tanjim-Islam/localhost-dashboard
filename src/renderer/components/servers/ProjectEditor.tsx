import type { Project } from "../../../shared/servers";
import Modal from "../Modal";
import { button, input } from "./presentation";

export default function ProjectEditor({
  edit,
  busy,
  error,
  onClose,
  onChange,
  onSave,
}: {
  edit: Project;
  busy: boolean;
  error: string;
  onClose(): void;
  onChange(project: Project): void;
  onSave(): void;
}) {
  return (
    <Modal
      title="Edit project"
      busy={busy}
      error={error}
      onClose={() => onClose()}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <label className="block text-sm">
          Name
          <input
            required
            maxLength={120}
            autoFocus
            className={input + " mt-1"}
            value={edit.name}
            onChange={(e) => onChange({ ...edit, name: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          Notes
          <textarea
            rows={4}
            maxLength={4000}
            className={input + " mt-1"}
            value={edit.notes}
            onChange={(e) => onChange({ ...edit, notes: e.target.value })}
          />
        </label>
        <div className="flex gap-5 text-sm">
          <label>
            <input
              type="checkbox"
              checked={edit.pinned}
              onChange={(e) => onChange({ ...edit, pinned: e.target.checked })}
            />{" "}
            Pin
          </label>
          <label>
            <input
              type="checkbox"
              checked={edit.bookmarked}
              onChange={(e) =>
                onChange({ ...edit, bookmarked: e.target.checked })
              }
            />{" "}
            Bookmark
          </label>
        </div>
        <div className="flex justify-end">
          <button
            disabled={busy}
            className={`${button} bg-night-700 text-night-100`}
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
