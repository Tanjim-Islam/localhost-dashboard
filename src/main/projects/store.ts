import Store from "electron-store";
import { getAllNotes } from "../notes";
import { migrateProjectState, ProjectModel, type ProjectState } from "./model";

export function createProjectStore(): {
  model: ProjectModel;
  flush: () => void;
} {
  const store = new Store<{ state: ProjectState }>({ name: "projects" });
  const state = migrateProjectState(store.get("state"), getAllNotes());
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    store.set("state", state);
  };
  // Coalesce observations. Mutations are flushed explicitly by IPC before returning.
  const model = new ProjectModel(state, () => {
    timer ??= setTimeout(flush, 30000);
  });
  flush(); // Idempotent note migration, original port-notes.json is retained.
  return { model, flush };
}
