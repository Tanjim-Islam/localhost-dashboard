import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
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
  handle("projects:add", async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      properties: ["openDirectory"],
      title: "Choose project folder",
    });
    if (result.canceled || !result.filePaths[0]) return model.snapshot();
    const directory = await fs.realpath(result.filePaths[0]);
    const project = model.ensure(directory, path.basename(directory));
    project.bookmarked = true;
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
    const key = await scanner.associationKey(item);
    model.associate(key, edit.projectId);
    return publish();
  });
  handle("projects:legacy-note", (value) => {
    const v = object(value);
    model.attachLegacy(id(v.noteId), id(v.projectId));
    return publish();
  });
  handle("servers:stop-preview", (value) => stopper.preview(value));
  handle("servers:stop", (value) => stopper.execute(id(value)));
}
