export function TransportControls({
  isPlaying, isRecording, onPlay, onPause, onStop, onRecord
}: {
  isPlaying: boolean;
  isRecording: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onRecord: () => void;
}) {
  return <div className="transport">
    <button className={isPlaying ? "active" : ""} onClick={onPlay} title="Play">▶</button>
    <button className={!isPlaying ? "active" : ""} onClick={onPause} title="Pause">Ⅱ</button>
    <button onClick={onStop} title="Stop and reset">■</button>
    <button className={isRecording ? "recording" : ""} onClick={onRecord}
      title={isRecording ? "Stop recording" : "Record"}>●</button>
  </div>;
}
