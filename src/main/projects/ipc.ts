import { ipcMain, shell, type BrowserWindow } from "electron";
import { associationEdit, id, object, projectEdit } from "../../shared/servers";
import type { Scanner } from "../scanner";
import type { ProjectModel } from "./model";
import type { ServerStopController } from "./stop-controller";

export function registerProjectIpc(
  getWindow: () => BrowserWindow | null,
  model: ProjectModel,
  scanner: Scanner,
  stopper: ServerStopController,
  flush: () => void,
): void {
  const publish = () => {
    scanner.redecorate();
    flush();
    getWindow()?.webContents.send("projects:update", model.snapshot());
    return model.snapshot();
  };
  const handle = (channel: string, action: (value: unknown) => unknown) =>
    ipcMain.handle(channel, (event, value: unknown) => {
      const win = getWindow();
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error("This action is only available from the dashboard.");
      return action(value);
    });
  handle("projects:get", () => model.snapshot());
  handle("projects:open-folder", async (value) => {
    if (
      typeof value !== "string" ||
      !model.state.projects.some((p) => p.directory === value)
    )
      throw new Error("Unknown project folder.");
    if (await shell.openPath(value))
      throw new Error("Could not open project folder.");
  });
  handle("servers:get", () => scanner.getItems());
  handle("projects:edit", (value) => {
    model.edit(projectEdit(value));
    return publish();
  });
  handle("projects:associate", async (value) => {
    const edit = associationEdit(value);
    const item = scanner
      .getItems()
      .find(
        (i) => i.key === edit.ref.key && i.firstSeen === edit.ref.firstSeen,
      );
    if (!item)
      throw new Error("The service changed. Refresh and select it again.");
    if (item.discovery === "application")
      throw new Error(
        "Application services cannot be assigned to development projects.",
      );
    const key = await scanner.associationKey(item);
    model.associate(key, edit.projectId);
    return publish();
  });
  handle("projects:legacy-note", (value) => {
    const v = object(value);
    model.attachLegacy(id(v.noteId), id(v.projectId));
    return publish();
  });
  handle("servers:stop", (value) => stopper.stop(value));
}
