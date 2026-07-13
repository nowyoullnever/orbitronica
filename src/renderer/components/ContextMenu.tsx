import type { ContextMenuState } from "../state/types";
import { PopupMenu, PopupMenuItem, type PopupMenuCloseReason } from "./PopupMenu";

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
  onAddStopBar,
  onClose
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
  onClose: (reason: PopupMenuCloseReason) => void;
}) {
  return (
    <PopupMenu
      position={{ x: menu.x, y: menu.y }}
      ariaLabel="Canvas commands"
      className="context-menu"
      onClose={onClose}
      propagateEscape
    >
      {menu.orbitId ? (
        <>
          {menu.planetId && <PopupMenuItem onClick={onCopyPlanet}>Copy Planet <kbd>Ctrl+C</kbd></PopupMenuItem>}
          {hasPlanetClipboard && <PopupMenuItem onClick={onPastePlanetHere}>Paste Planet Here <kbd>Ctrl+V</kbd></PopupMenuItem>}
          {sequenceMode && <PopupMenuItem onClick={onAddPlayBar}>Add Play Bar</PopupMenuItem>}
          {sequenceMode && <PopupMenuItem onClick={onAddStopBar}>Add Stop Bar</PopupMenuItem>}
          <PopupMenuItem onClick={onToggleMode}>Toggle Loop / Sequence <kbd>M</kbd></PopupMenuItem>
          <PopupMenuItem onClick={onTogglePause}>Pause / Resume Orbit <kbd>Space</kbd></PopupMenuItem>
          <PopupMenuItem onClick={onDuplicate}>Duplicate Orbit <kbd>Ctrl+D</kbd></PopupMenuItem>
        </>
      ) : (
        <PopupMenuItem onClick={onUpload}>Upload Audio</PopupMenuItem>
      )}
    </PopupMenu>
  );
}
