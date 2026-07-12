class OrbitronicaPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recordingId = null;
    this.left = [];
    this.right = [];
    this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "start") {
        this.recordingId = data.recordingId;
        this.left = [];
        this.right = [];
        this.frames = 0;
        this.port.postMessage({ type: "started", recordingId: data.recordingId });
      } else if (data.type === "stop" && data.recordingId === this.recordingId) {
        this.flush();
        this.port.postMessage({ type: "stopped", recordingId: data.recordingId });
        this.recordingId = null;
      }
    };
  }

  flush() {
    if (!this.frames) return;
    const left = new Float32Array(this.frames);
    const right = new Float32Array(this.frames);
    let offset = 0;
    for (const block of this.left) { left.set(block, offset); offset += block.length; }
    offset = 0;
    for (const block of this.right) { right.set(block, offset); offset += block.length; }
    this.port.postMessage({ type: "chunk", recordingId: this.recordingId, left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]);
    this.left = [];
    this.right = [];
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recordingId !== null) {
      const left = input[0];
      const right = input[1] || left;
      const length = left ? left.length : 128;
      const copyLeft = new Float32Array(length);
      const copyRight = new Float32Array(length);
      if (left) copyLeft.set(left);
      if (right) copyRight.set(right);
      this.left.push(copyLeft);
      this.right.push(copyRight);
      this.frames += length;
      if (this.frames >= 2048) this.flush();
    }
    return true;
  }
}

registerProcessor("orbitronica-pcm-capture", OrbitronicaPcmCapture);
