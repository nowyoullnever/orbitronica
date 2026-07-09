import type { ContextMenuState } from "../state/types";

export function ContextMenu({
  menu, sequenceMode, onUpload, onToggleMode, onTogglePause, onDuplicate, onAddPlayBar, onAddStopBar
}: {
  menu: ContextMenuState;
  sequenceMode: boolean;
  onUpload: () => void;
  onToggleMode: () => void;
  onTogglePause: () => void;
  onDuplicate: () => void;
  onAddPlayBar: () => void;
  onAddStopBar: () => void;
}) {
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
      {menu.orbitId ? (
        <>
          {sequenceMode && <button onClick={onAddPlayBar}>Add Play Bar <kbd>▶</kbd></button>}
          {sequenceMode && <button onClick={onAddStopBar}>Add Stop Bar <kbd>■</kbd></button>}
          <button onClick={onToggleMode}>Toggle Loop / Sequence <kbd>M</kbd></button>
          <button onClick={onTogglePause}>Pause / Resume Orbit <kbd>Space</kbd></button>
          <button onClick={onDuplicate}>Duplicate Orbit <kbd>Ctrl+D</kbd></button>
        </>
      ) : (
        <button onClick={onUpload}>Upload Audio… <kbd>⌘O</kbd></button>
      )}
    </div>
  );
}
