import { useRef, useState } from "react";
import type { Scene } from "../state/types";
import { nextSceneTabIndex, type TabNavigationKey } from "../state/scenes.ts";

type Props = {
  scenes: readonly Pick<Scene, "id" | "name">[];
  activeSceneId: string;
  onActivate: (sceneId: string) => void;
  onAdd: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  duplicateDisabled?: boolean;
  onRename: (sceneId: string, name: string) => void;
  onReorder: (draggedSceneId: string, targetSceneId: string) => void;
};

export function SceneTabs(props: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const renameCanceled = useRef(false);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  const beginRename = (scene: Pick<Scene, "id" | "name">) => {
    renameCanceled.current = false;
    setEditingId(scene.id);
    setDraft(scene.name);
  };
  const commitRename = (sceneId: string) => {
    if (renameCanceled.current) {
      renameCanceled.current = false;
    } else {
      props.onRename(sceneId, draft);
    }
    setEditingId(null);
  };

  return <nav className="scene-tabs" aria-label="Scenes">
    <div className="scene-tab-list" role="tablist" aria-label="Project scenes">
      {props.scenes.map((scene, index) => <div
        className={`scene-tab ${scene.id === props.activeSceneId ? "active" : ""} ${draggingId === scene.id ? "dragging" : ""}`}
        key={scene.id}
        role="tab"
        aria-selected={scene.id === props.activeSceneId}
        tabIndex={scene.id === props.activeSceneId ? 0 : -1}
        ref={(element) => {
          if (element) tabRefs.current.set(scene.id, element);
          else tabRefs.current.delete(scene.id);
        }}
        draggable={editingId !== scene.id}
        onClick={() => props.onActivate(scene.id)}
        onDoubleClick={() => beginRename(scene)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onActivate(scene.id);
          }
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const nextIndex = nextSceneTabIndex(index, props.scenes.length, event.key as TabNavigationKey);
            const next = props.scenes[nextIndex];
            if (next) {
              props.onActivate(next.id);
              tabRefs.current.get(next.id)?.focus();
            }
          }
        }}
        onDragStart={(event) => {
          setDraggingId(scene.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", scene.id);
        }}
        onDragEnd={() => setDraggingId(null)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const draggedId = event.dataTransfer.getData("text/plain") || draggingId;
          setDraggingId(null);
          if (draggedId) props.onReorder(draggedId, scene.id);
        }}
      >
        {editingId === scene.id ? <input
          className="scene-tab-rename"
          aria-label={`Rename ${scene.name}`}
          autoFocus
          value={draft}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commitRename(scene.id)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              renameCanceled.current = true;
              event.currentTarget.blur();
            }
          }}
        /> : <span>{scene.name}</span>}
      </div>)}
    </div>
    <div className="scene-tab-actions">
      <button type="button" onClick={props.onAdd} aria-label="Add scene" title="Add scene">+</button>
      <button type="button" onClick={props.onDuplicate} disabled={props.duplicateDisabled}
        aria-label="Duplicate active scene" title="Duplicate active scene">⧉</button>
      <button type="button" onClick={props.onDelete} disabled={props.scenes.length <= 1}
        aria-label="Delete active scene" title="Delete active scene">−</button>
    </div>
  </nav>;
}
