import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { WavSampleFormat } from "../audio/wavEncoder";

type Props = {
  sampleFormat: WavSampleFormat;
  onClose: () => void;
  onSave: (sampleFormat: WavSampleFormat) => Promise<void>;
};

const formats: Array<{ value: WavSampleFormat; label: string }> = [
  { value: "pcm16", label: "16-bit PCM (default)" },
  { value: "pcm24", label: "24-bit PCM" },
  { value: "float32", label: "32-bit float (lossless)" }
];

export function PreferencesModal({ sampleFormat, onClose, onSave }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [selectedFormat, setSelectedFormat] = useState<WavSampleFormat>(sampleFormat);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => setSelectedFormat(sampleFormat), [sampleFormat]);
  useEffect(() => {
    // The menu action that opened the dialog should remain the user's next focus
    // target after closing it. Do this in cleanup so Escape, Cancel, backdrop, and
    // successful Save share the same restoration behavior.
    const previouslyFocused = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(undefined);
    try {
      await onSave(selectedFormat);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preferences could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  return <div className="preferences-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !isSaving) onClose();
  }}>
    <section className="preferences-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header className="preferences-header">
        <div>
          <p className="panel-eyebrow">APPLICATION</p>
          <h2 id={titleId}>Preferences</h2>
        </div>
        <button ref={closeButton} className="preferences-close" type="button" aria-label="Close preferences" onClick={onClose} disabled={isSaving}>×</button>
      </header>
      <form onSubmit={submit}>
        <div className="preferences-section">
          <h3>Export</h3>
          <label>
            <span>CONTAINER</span>
            <output>WAV</output>
          </label>
          <label htmlFor="preference-sample-format">
            <span>SAMPLE FORMAT</span>
            <select id="preference-sample-format" value={selectedFormat} disabled={isSaving}
              onChange={(event) => setSelectedFormat(event.target.value as WavSampleFormat)}>
              {formats.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
            </select>
          </label>
          <p id={descriptionId} className="preferences-help">32-bit float preserves the internal master signal exactly. 16-bit PCM is best for standard distribution.</p>
        </div>
        {error && <p className="preferences-error" role="alert">{error}</p>}
        <footer className="preferences-actions">
          <button type="button" onClick={onClose} disabled={isSaving}>Cancel</button>
          <button type="submit" disabled={isSaving}>{isSaving ? "Saving…" : "Save preferences"}</button>
        </footer>
      </form>
    </section>
  </div>;
}
