export function TransportControls({
  isPlaying, onPlay, onPause, onStop
}: {
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  return (
    <div className="transport">
      <button className={isPlaying ? "active" : ""} onClick={onPlay} title="Play" aria-label="Play">▶</button>
      <button className={!isPlaying ? "active" : ""} onClick={onPause} title="Pause" aria-label="Pause">Ⅱ</button>
      <button onClick={onStop} title="Stop and reset" aria-label="Stop">■</button>
    </div>
  );
}
