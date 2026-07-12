import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

export type MenuAction = "open-project" | "save-project" | "save-project-as" | "preferences";

function send(action: MenuAction) {
  const window = BrowserWindow.getFocusedWindow();
  if (window && !window.isDestroyed()) window.webContents.send("menu:action", action);
}

const customEdit = (label: string, action: "undo" | "redo" | "copy" | "paste"): MenuItemConstructorOptions => ({
  label,
  click: () => BrowserWindow.getFocusedWindow()?.webContents[action]()
});

export function installAppMenu() {
  const preferences: MenuItemConstructorOptions = { label: "Preferences…", click: () => send("preferences") };
  const template: any[] = [
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [{ role: "about" }, preferences, { type: "separator" }, { role: "services" }, { role: "hide" }, { role: "hideOthers" }, { role: "quit" }] }] : []),
    { label: "File", submenu: [
      { label: "Open…", click: () => send("open-project") },
      { label: "Save", click: () => send("save-project") },
      { label: "Save As…", click: () => send("save-project-as") },
      { role: "close" }
    ] },
    { label: "Edit", submenu: [
      ...(process.platform === "darwin" ? [] : [preferences]),
      customEdit("Undo", "undo"), customEdit("Redo", "redo"), { type: "separator" },
      customEdit("Copy", "copy"), customEdit("Paste", "paste"), { role: "cut" }, { role: "selectAll" }
    ] },
    { label: "View", submenu: [
      { role: "reload" }, { role: "togglefullscreen" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
      ...(process.argv.includes("--dev") ? [{ type: "separator" as const }, { role: "toggleDevTools" as const }] : [])
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
