// The chat box's mic, its audio worklet (voice.js loads it): collects the mic's samples into frames of
// processorOptions.frame samples (30 ms) and posts each to the page, off the page's thread. A file of its own, since
// the page's Content-Security-Policy loads script only from the server's files (no blob: URL).
registerProcessor('fv-tap', class extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.size = (o && o.processorOptions && o.processorOptions.frame) || 480;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf); this.buf = new Float32Array(this.size); this.n = 0; }
    }
    return true;
  }
});
