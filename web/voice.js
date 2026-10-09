// The chat box's mic: it records the default microphone, cuts what it hears at the pauses, and has Whisper
// (voice-worker.js, on this PC) write each stretch out. It listens until it is stopped.
//   voiceSupported() -> bool
//   startVoice() -> Promise<{ ok, token?, message? }>   one at a time: a start stops the one before (dropping
//                       what it had not written yet)
//   stopVoice(token, flush)   flush: what was said up to now is still written out, then "end"; otherwise it is
//                       dropped and "end" comes at once
//   onVoice(cb(token, { t, text, stretch? })) -> unsubscribe. t:
//     "ready"   listening
//     "status"  text: a line about the model ("Loading the speech model … 40%"), '' when done
//     "busy"    text: how many stretches are being written out ("0" when none)
//     "partial" text: a first go at the stretch still being said (stretch: its number, counting from 1 for each
//               start), replaced by the next one; '' when its stretch turned out to hold no words. Only a preview:
//               the stretch's "final" (or "end") takes its place
//     "final"   text: what was said in one stretch (stretch: its number)
//     "end" / "error"  it stopped (error: text says why)
const SR = 16000;
const FRAME = 480; // 30 ms
const PREROLL = 10; // frames kept from before speech starts (300 ms), so the first syllable is not cut
const START = 3; // loud frames in a row that start a stretch
const END_QUIET = 27; // quiet frames (~800 ms) that end one
const MAX_FRAMES = Math.round((25 * SR) / FRAME); // a stretch never runs past 25 s (Whisper hears 30 s at a time)
const MIN_VOICED = 8; // a stretch with less speech than this (~240 ms) is a cough or a click: dropped
// the preview ("partial"): while a stretch goes on, what it holds so far is written out about every second, but
// only when the worker has nothing else to do, so a preview never waits behind another run and a stretch's final
// waits for one short run at most. A slow PC backs off: a preview that took more than 1.5 times its gap moves the gap
// up a step (1 s, 2 s, 3 s); one too slow at 3 s turns the preview off until the mic is next started. On the CPU
// model (no WebGPU) it starts at 3 s.
const GAPS = [33, 67, 100]; // frames between previews: ~1, 2 and 3 s of new speech (the first comes ~1 gap in)
let gapStep = 0, previewOff = false, device = ''; // device: what the model runs on ('webgpu' / 'wasm')

const listeners = new Set();
const emit = (token, ev) => { for (const cb of listeners) { try { cb(token, ev); } catch {} } };
export const onVoice = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
export const voiceSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode && window.Worker);

// ----- the worker (kept for the life of the page: the model takes a while to load) -----
let worker = null, model = 'none', modelNote = ''; // model: none / loading / ready / failed
const jobs = new Map(); // job id -> { token, drop, stretch, interim, step, at }
let jobSeq = 0;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
  model = 'loading';
  worker.onmessage = ({ data: m }) => {
    if (!m) return;
    if (m.t === 'progress') { modelNote = `Loading the speech model (the first time it downloads about 400 MB) ${m.pct}%`; if (cur) emit(cur.token, { t: 'status', text: modelNote }); }
    else if (m.t === 'warming') { modelNote = 'Getting the speech model ready…'; if (cur) emit(cur.token, { t: 'status', text: modelNote }); }
    else if (m.t === 'ready') { model = 'ready'; device = m.device || ''; modelNote = ''; if (cur) emit(cur.token, { t: 'status', text: '' }); }
    else if (m.t === 'error') {
      model = 'failed';
      modelNote = '';
      if (cur) { const t = cur.token; halt(); emit(t, { t: 'error', text: `the speech model did not load: ${m.text}` }); }
    } else if (m.t === 'text') {
      const j = jobs.get(m.id);
      if (!j) return;
      jobs.delete(m.id);
      const c = cur && cur.token === j.token ? cur.seg : null;
      if (j.interim) {
        // too slow for its gap: the next gap up, or no more previews this time
        if (performance.now() - j.at > 1.5 * GAPS[j.step] * (FRAME / SR) * 1000) {
          if (j.step < GAPS.length - 1) gapStep = Math.max(gapStep, j.step + 1); else previewOff = true;
        }
        // shown only while its stretch is the one being said and its final has not come back yet
        if (!j.drop && m.text && c && c.stretch === j.stretch && c.done < j.stretch) emit(j.token, { t: 'partial', text: m.text, stretch: j.stretch });
        return;
      }
      if (c) c.done = Math.max(c.done, j.stretch);
      if (!j.drop) emit(j.token, m.text ? { t: 'final', text: m.text, stretch: j.stretch } : { t: 'partial', text: '', stretch: j.stretch });
      const left = pending(j.token);
      emit(j.token, { t: 'busy', text: String(left) });
      if (!left && ended.has(j.token)) { ended.delete(j.token); emit(j.token, { t: 'end', text: 'Stopped' }); }
      keepAwake();
    }
  };
  worker.onerror = (e) => {
    model = 'failed';
    const why = e?.message || 'the speech worker failed';
    worker = null;
    for (const [id, j] of jobs) { jobs.delete(id); if (!j.drop && !j.interim) emit(j.token, { t: 'error', text: why }); }
    if (cur) { const t = cur.token; halt(); emit(t, { t: 'error', text: why }); }
    keepAwake();
  };
  worker.postMessage({ t: 'load' });
  return worker;
}
// while the mic listens or its last words are being written out, the desktop window keeps full speed behind other
// windows (Chromium slows a hidden page and its GPU work down); off again once all of it is done
let awake = false;
function keepAwake() {
  const on = !!cur || jobs.size > 0;
  if (on === awake) return;
  awake = on;
  try { window.fleetDesktop?.keepAwake?.(on); } catch {}
}
// the stretches still being written out (previews don't count: nothing waits for them)
const pending = (token) => { let n = 0; for (const j of jobs.values()) if (j.token === token && !j.interim) n++; return n; };
const ended = new Set(); // tokens stopped with flush, waiting for their last stretches

// info: { stretch, interim?, step? } (interim: a preview of a stretch still going on, step: its gap's index in GAPS)
function transcribe(token, frames, info) {
  if (frames.length > MAX_FRAMES) frames = frames.slice(0, MAX_FRAMES);
  let n = 0;
  for (const f of frames) n += f.length;
  const audio = new Float32Array(n);
  let o = 0, peak = 0;
  for (const f of frames) { audio.set(f, o); o += f.length; }
  for (let i = 0; i < n; i++) { const a = Math.abs(audio[i]); if (a > peak) peak = a; }
  // a quiet mic: bring it up to a normal level (Whisper misses words in near-silence)
  const gain = peak > 0 ? Math.min(0.9 / peak, 60) : 1;
  if (gain > 1.05) for (let i = 0; i < n; i++) audio[i] *= gain;
  const id = ++jobSeq;
  const interim = !!info.interim;
  jobs.set(id, { token, drop: false, stretch: info.stretch, interim, step: info.step || 0, at: performance.now() });
  getWorker().postMessage({ t: 'run', id, audio, interim }, [audio.buffer]);
  if (!interim) emit(token, { t: 'busy', text: String(pending(token)) });
}

// ----- cutting at the pauses: a loud frame is well above the room's own noise, which it keeps measuring -----
// (stretch: the number of the stretch being said or said last; done: the newest one whose final came back)
function segmenter(token) {
  let noise = 0, seen = 0, loudRun = 0, quietRun = 0, voiced = 0;
  let pre = [], seg = null, previewAt = 0; // previewAt: the stretch's length when its last preview went
  const close = () => {
    if (seg && voiced >= MIN_VOICED) transcribe(token, seg, { stretch: me.stretch });
    seg = null; voiced = 0; quietRun = 0;
  };
  // the stretch so far, for a preview: once there is a gap's worth of new speech and the worker is idle
  const preview = () => {
    if (previewOff || model !== 'ready' || jobs.size || voiced < MIN_VOICED) return;
    const step = device === 'wasm' ? Math.max(gapStep, GAPS.length - 1) : gapStep;
    if (seg.length - previewAt < GAPS[step]) return;
    previewAt = seg.length;
    transcribe(token, seg, { stretch: me.stretch, interim: true, step });
  };
  const me = {
    stretch: 0, done: 0,
    push(f) {
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      const rms = Math.sqrt(s / f.length);
      seen++;
      if (seen <= 10) noise = noise ? Math.min(noise, rms) : rms; // the first 300 ms: the room
      const loud = seen > 10 && rms > Math.max(noise * 3, 0.0008);
      if (!seg && !loud) noise = noise * 0.98 + Math.min(rms, noise * 2) * 0.02; // follows the room, slowly
      noise = Math.max(noise, 0.00005);
      if (!seg) {
        pre.push(f);
        if (pre.length > PREROLL) pre.shift();
        loudRun = loud ? loudRun + 1 : 0;
        if (loudRun >= START) { seg = pre; pre = []; voiced = loudRun; quietRun = 0; previewAt = 0; me.stretch++; }
        return;
      }
      seg.push(f);
      if (loud) { voiced++; quietRun = 0; } else quietRun++;
      if (quietRun >= END_QUIET || seg.length >= MAX_FRAMES) { close(); loudRun = 0; }
      else preview();
    },
    flush: close,
  };
  return me;
}

// collects the mic's samples into 30 ms frames, off the page's thread
const TAP = `registerProcessor('fv-tap', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${FRAME}) { this.port.postMessage(this.buf); this.buf = new Float32Array(${FRAME}); this.n = 0; }
    }
    return true;
  }
});`;
let tapUrl = null;

// ----- one dictation at a time -----
let cur = null; // { token, stream, ctx, seg }
let tokenSeq = 0;
function halt() {
  const c = cur;
  cur = null;
  if (!c) return null;
  try { for (const t of c.stream.getTracks()) t.stop(); } catch {}
  try { c.ctx?.close(); } catch {}
  keepAwake();
  return c;
}

export async function startVoice() {
  if (!voiceSupported()) return { ok: false, message: 'this window cannot record sound' };
  if (cur) stopVoice(cur.token, false);
  const token = ++tokenSeq;
  const me = { token, stream: null, ctx: null, seg: segmenter(token) };
  gapStep = 0; previewOff = false; // the preview starts at its quickest again (a busy PC may have calmed down)
  cur = me;
  keepAwake();
  if (model === 'failed') { worker = null; model = 'none'; } // try loading again
  getWorker();
  try {
    me.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (cur !== me) { for (const t of me.stream.getTracks()) t.stop(); return { ok: false, message: 'stopped' }; }
    me.ctx = new AudioContext({ sampleRate: SR });
    if (!tapUrl) tapUrl = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    await me.ctx.audioWorklet.addModule(tapUrl);
    if (cur !== me) { try { me.ctx.close(); } catch {} for (const t of me.stream.getTracks()) t.stop(); return { ok: false, message: 'stopped' }; }
    const src = me.ctx.createMediaStreamSource(me.stream);
    const tap = new AudioWorkletNode(me.ctx, 'fv-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const mute = me.ctx.createGain();
    mute.gain.value = 0; // the graph has to reach the speakers to run; it does so silently
    tap.port.onmessage = (e) => { if (cur === me) me.seg.push(e.data); };
    src.connect(tap).connect(mute).connect(me.ctx.destination);
    // the window went behind another one and the sound stopped: start it again (it keeps listening there)
    me.ctx.addEventListener('statechange', () => { if (cur === me && me.ctx.state === 'suspended') me.ctx.resume().catch(() => {}); });
    me.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (cur === me) { stopVoice(token, true); }
    });
  } catch (e) {
    if (cur === me) halt();
    const name = e?.name || '';
    return { ok: false, message: name === 'NotAllowedError' ? 'the microphone is blocked for this window'
      : name === 'NotFoundError' ? 'no microphone found' : `could not open the microphone: ${e?.message || e}` };
  }
  setTimeout(() => {
    if (cur !== me) return;
    emit(token, { t: 'ready', text: '' });
    if (modelNote) emit(token, { t: 'status', text: modelNote });
  }, 0);
  return { ok: true, token };
}

export function stopVoice(token, flush) {
  if (cur && cur.token === token) {
    const c = halt();
    if (flush) c.seg.flush();
  }
  if (flush && pending(token)) { ended.add(token); return; }
  for (const j of jobs.values()) if (j.token === token) j.drop = true;
  ended.delete(token);
  emit(token, { t: 'end', text: 'Stopped' });
}
