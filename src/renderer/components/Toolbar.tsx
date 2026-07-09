import type { Tool } from "../state/types";

const tools: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: "select", icon: "↖", label: "Select", hint: "Select an orbit" },
  { id: "planet", icon: "●", label: "Planet", hint: "Place a moving planet" },
  { id: "bar", icon: "╱", label: "Bar", hint: "Place a trigger bar" }
];

export function Toolbar({ selected, onSelect }: { selected: Tool; onSelect: (tool: Tool) => void }) {
  return (
    <aside className="toolbar" aria-label="Tools">
      <div className="brand-mark">O</div>
      <div className="tool-group">
        {tools.map((tool) => (
          <button
            key={tool.id}
            className={`tool-button ${selected === tool.id ? "active" : ""}`}
            onClick={() => onSelect(tool.id)}
            title={tool.hint}
            aria-label={tool.label}
          >
            <span>{tool.icon}</span>
            <small>{tool.label}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}
