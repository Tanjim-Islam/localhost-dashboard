import { Code, Folder, Terminal } from "lucide-react";
import { button, iconButton } from "./presentation";

export default function ProjectActions({
  project,
  onError,
}: {
  project: { directory: string };
  onError(message: string): void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        className={button}
        onClick={() =>
          void window.api
            .openProjectFolder(project.directory)
            .catch(() => onError("Could not open project folder."))
        }
      >
        <Folder className="mr-1 inline" size={14} />
        Open project
      </button>
      <button
        className={iconButton}
        aria-label="Open terminal"
        title="Terminal"
        onClick={() =>
          void window.api
            .openTerminal(project.directory)
            .catch(() => onError("Could not open terminal."))
        }
      >
        <Terminal size={16} />
      </button>
      <button
        className={iconButton}
        aria-label="Open in VS Code"
        title="VS Code"
        onClick={() =>
          void window.api
            .openInVSCode({ path: project.directory })
            .catch(() => onError("Could not open VS Code."))
        }
      >
        <Code size={16} />
      </button>
    </div>
  );
}
