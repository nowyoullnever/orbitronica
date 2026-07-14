import { useEffect, useState } from "react";

function formatMetric(value: number, decimals: number) {
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

export function EditableMetric({
  label, value, decimals, suffix, step, min, max, disabled, onApply
}: {
  label: string;
  value: number;
  decimals: number;
  suffix: string;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onApply: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatMetric(value, decimals));
  const [isEditing, setIsEditing] = useState(false);
  useEffect(() => {
    if (!isEditing) setDraft(formatMetric(value, decimals));
  }, [value, decimals, isEditing]);

  const apply = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatMetric(value, decimals));
      return;
    }
    const rounded = decimals === 0 ? Math.round(parsed) : Number(parsed.toFixed(decimals));
    onApply(rounded);
  };

  return <div className="editable-metric">
    <span>{label}</span>
    <input type="number" value={draft} step={step} min={min} max={max} disabled={disabled}
      onFocus={() => setIsEditing(true)}
      onBlur={() => { setIsEditing(false); apply(); }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
          event.currentTarget.blur();
        }
      }} />
    <em>{suffix}</em>
    <button type="button" disabled={disabled} onClick={apply}>Apply</button>
  </div>;
}
