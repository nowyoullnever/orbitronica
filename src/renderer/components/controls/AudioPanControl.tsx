import { useEffect, useState } from "react";

export function AudioPanControl({ label, value, onChange }: { label: string; value: number; onChange: (audioPan: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isEditing) setDraft(String(value));
  }, [value, isEditing]);

  const applyDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(nextDraft)) {
      setError("Please enter a valid number.");
      return;
    }
    const parsed = Number(nextDraft);
    if (parsed > 100) {
      setError("Please enter a value less than or equal to 100.");
      return;
    }
    if (parsed < -100) {
      setError("Please enter a value greater than or equal to -100.");
      return;
    }
    setError(null);
    onChange(parsed);
  };
  const reset = () => {
    setDraft("0");
    setError(null);
    onChange(0);
  };

  return <div className="audio-pan-control">
    <label><span>{label} <output>{value > 0 ? "+" : ""}{value}</output></span>
      <input type="range" min="-100" max="100" step="1" value={value}
        onChange={(event) => { setDraft(event.target.value); setError(null); onChange(Number(event.target.value)); }}
        onDoubleClick={reset} />
    </label>
    <input className="audio-pan-number" type="text" inputMode="decimal" value={draft} aria-label={`${label} value`}
      onFocus={() => setIsEditing(true)}
      onChange={(event) => applyDraft(event.target.value)}
      onBlur={() => setIsEditing(false)}
      onDoubleClick={reset} />
    {error && <small className="audio-pan-error">{error}</small>}
  </div>;
}
