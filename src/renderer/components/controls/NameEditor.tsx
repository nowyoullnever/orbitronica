import { useEffect, useState } from "react";

export function NameEditor({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return <input value={draft} onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} />;
}
