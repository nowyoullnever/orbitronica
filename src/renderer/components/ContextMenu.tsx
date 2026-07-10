import type { ContextMenuState } from "../state/types";

export function ContextMenu({
  menu,
  sequenceMode,
  hasPlanetClipboard,
  onUpload,
  onToggleMode,
  onTogglePause,
  onDuplicate,
  onCopyPlanet,
  onPastePlanetHere,
  onAddPlayBar,
  onAddStopBar
}: {
  menu: ContextMenuState;
  sequenceMode: boolean;
  hasPlanetClipboard: boolean;
  onUpload: () => void;
  onToggleMode: () => void;
  onTogglePause: () => void;
  onDuplicate: () => void;
  onCopyPlanet: () => void;
  onPastePlanetHere: () => void;
  onAddPlayBar: () => void;
  onAddStopBar: () => void;
}) {
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
      {menu.orbitId ? (
        <>
          {menu.planetId && <button onClick={onCopyPlanet}>Copy Planet <kbd>Ctrl+C</kbd></button>}
          {hasPlanetClipboard && <button onClick={onPastePlanetHere}>Paste Planet Here <kbd>Ctrl+V</kbd></button>}
          {sequenceMode && <button onClick={onAddPlayBar}>Add Play Bar</button>}
          {sequenceMode && <button onClick={onAddStopBar}>Add Stop Bar</button>}
          <button onClick={onToggleMode}>Toggle Loop / Sequence <kbd>M</kbd></button>
          <button onClick={onTogglePause}>Pause / Resume Orbit <kbd>Space</kbd></button>
          <button onClick={onDuplicate}>Duplicate Orbit <kbd>Ctrl+D</kbd></button>
        </>
      ) : (
        <button onClick={onUpload}>Upload Audio</button>
      )}
    </div>
  );
}
