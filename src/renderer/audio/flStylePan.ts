export type FLStylePanMatrix = {
  leftToLeft: number;
  leftToRight: number;
  rightToLeft: number;
  rightToRight: number;
};

export function normalizeAudioPan(audioPan: number) {
  if (!Number.isFinite(audioPan)) return 0;
  return Math.max(-1, Math.min(1, audioPan / 100));
}

// FL-style panning moves the opposite channel into the selected side instead
// of merely attenuating it. This intentionally differs from balance panning.
export function getFLStylePanMatrix(audioPan: number): FLStylePanMatrix {
  const pan = normalizeAudioPan(audioPan);
  if (pan >= 0) return {
    leftToLeft: 1 - pan,
    leftToRight: pan,
    rightToLeft: 0,
    rightToRight: 1
  };
  return {
    leftToLeft: 1,
    leftToRight: 0,
    rightToLeft: -pan,
    rightToRight: 1 + pan
  };
}

export type FLStylePanNode = {
  input: GainNode;
  output: ChannelMergerNode;
  setPan: (audioPan: number) => void;
  disconnect: () => void;
};

export function createFLStylePanNode(context: AudioContext, inputChannels: number, audioPan = 0): FLStylePanNode {
  const input = context.createGain();
  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);
  const leftToLeft = context.createGain();
  const leftToRight = context.createGain();
  const rightToLeft = context.createGain();
  const rightToRight = context.createGain();
  const rightInput = inputChannels === 1 ? 0 : 1;

  input.connect(splitter);
  splitter.connect(leftToLeft, 0); leftToLeft.connect(merger, 0, 0);
  splitter.connect(leftToRight, 0); leftToRight.connect(merger, 0, 1);
  splitter.connect(rightToLeft, rightInput); rightToLeft.connect(merger, 0, 0);
  splitter.connect(rightToRight, rightInput); rightToRight.connect(merger, 0, 1);

  const gains = { leftToLeft, leftToRight, rightToLeft, rightToRight };
  const setPan = (nextAudioPan: number) => {
    const matrix = getFLStylePanMatrix(nextAudioPan);
    const now = context.currentTime;
    for (const [key, gain] of Object.entries(gains) as Array<[keyof FLStylePanMatrix, GainNode]>) {
      gain.gain.setTargetAtTime(matrix[key], now, .005);
    }
  };
  setPan(audioPan);
  return {
    input,
    output: merger,
    setPan,
    disconnect: () => {
      try { input.disconnect(); } catch { /* already disconnected */ }
      try { splitter.disconnect(); } catch { /* already disconnected */ }
      try { merger.disconnect(); } catch { /* already disconnected */ }
      for (const gain of Object.values(gains)) try { gain.disconnect(); } catch { /* already disconnected */ }
    }
  };
}
