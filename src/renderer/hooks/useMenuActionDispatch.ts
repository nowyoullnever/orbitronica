import { useEffect, useRef } from "react";

// Mirrors the Window.orbitonicAPI.onMenuAction listener's action union declared ambiently
// in global.d.ts (that file is a module via `export {}`, so its local MenuAction type isn't
// importable here — this local copy is the same duplication App.tsx already carried).
export type MenuAction = "open-project" | "save-project" | "save-project-as" | "preferences";

export type MenuActionHandlers = Record<MenuAction, () => void | Promise<void>>;

/**
 * Keeps one IPC subscription to window.orbitonicAPI.onMenuAction alive for the component's
 * lifetime while always routing to the latest render's handlers.
 */
export function useMenuActionDispatch(handlers: MenuActionHandlers) {
  const actionsRef = useRef<MenuActionHandlers>({
    "open-project": () => undefined,
    "save-project": () => undefined,
    "save-project-as": () => undefined,
    preferences: () => undefined
  });
  // Keep one IPC subscription while routing every menu action to the latest render's handlers.
  actionsRef.current = handlers;

  useEffect(() => {
    const api = window.orbitonicAPI;
    if (!api) return;
    return api.onMenuAction((action) => {
      void actionsRef.current[action]();
    });
  }, []);
}
