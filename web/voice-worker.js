// The chat box's mic, part 2: Whisper speech-to-text running on this PC, in a worker so the page never stalls.
// voice.js sends it what was said, one stretch of speech at a time; nothing leaves the machine except the one-time
// download of the library and the model (then both come from the browser's cache).
//   in:  { t: 'load' }                                  get the model ready (voice.js sends it on the first mic click)
//        { t: 'run', id, audio: Float32Array (16 kHz mono), interim? }
//                                interim: a preview of a stretch still being said. It is skipped (answered '') when
//                                another run waits behind it, so the stretches' own runs always come first
//   out: { t: 'progress', pct }  downloading the model (first time only)
//        { t: 'warming' }            downloaded; its first (slow) run on a second of silence is under way
//        { t: 'ready', device, model }
//        { t: 'text', id, text, interim }  for each run, in order ('' when nothing was said)
//        { t: 'error', text }     the model could not load (every later run answers '' and repeats it)
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
// on the graphics card (WebGPU) the small English model, which hears better; on the CPU the base one, which keeps up
const GPU = { model: 'onnx-community/whisper-small.en', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
const GPU_F16 = { model: GPU.model, dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } };
const CPU = { model: 'onnx-community/whisper-base.en', dtype: 'q8' };

let loading = null;
const files = new Map(); // file -> [loaded, total] while downloading

function progress(p) {
  if (!p || !p.file) return;
  if (p.status === 'progress' && p.total) files.set(p.file, [p.loaded || 0, p.total]);
  else if (p.status === 'done' && files.has(p.file)) { const f = files.get(p.file); files.set(p.file, [f[1], f[1]]); }
  else return;
  let got = 0, all = 0;
  for (const [a, b] of files.values()) { got += a; all += b; }
  if (all) postMessage({ t: 'progress', pct: Math.min(99, Math.floor((got / all) * 100)) });
}

// the first run on a new model is slow (the graphics card builds its shaders): done once on a second of silence,
// before 'ready', so the first words come back as fast as the rest
async function warm(asr) { postMessage({ t: 'warming' }); try { await asr(new Float32Array(16000)); } catch {} }

async function gpuPlan() {
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!a) return null;
    return a.features.has('shader-f16') ? GPU_F16 : GPU;
  } catch { return null; }
}

function load() {
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import(LIB);
      env.allowLocalModels = false;
      const gpu = await gpuPlan();
      if (gpu) {
        try {
          const asr = await pipeline('automatic-speech-recognition', gpu.model, { device: 'webgpu', dtype: gpu.dtype, progress_callback: progress });
          await warm(asr);
          postMessage({ t: 'ready', device: 'webgpu', model: gpu.model, dtype: gpu.dtype });
          return asr;
        } catch {} // no usable WebGPU after all: the CPU model
      }
      files.clear();
      const asr = await pipeline('automatic-speech-recognition', CPU.model, { device: 'wasm', dtype: CPU.dtype, progress_callback: progress });
      await warm(asr);
      postMessage({ t: 'ready', device: 'wasm', model: CPU.model });
      return asr;
    })();
    loading.catch((e) => postMessage({ t: 'error', text: String(e?.message || e).slice(0, 300) }));
  }
  return loading;
}

// Whisper's habits on noise or silence: a caption in brackets, or a sign-off it learned from videos
const JUNK = /^(\s*[([][^)\]]*[)\]]\s*)+$|^\s*(thank you\.?|thanks for watching!?|you|\.+|bye\.?)\s*$/i;
function clean(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return JUNK.test(t) ? '' : t;
}

// one at a time, in the order they came
let queue = Promise.resolve(), waiting = 0;
self.onmessage = ({ data }) => {
  if (!data) return;
  if (data.t === 'load') { load(); return; }
  if (data.t !== 'run') return;
  const interim = !!data.interim;
  waiting++;
  queue = queue.then(async () => {
    waiting--;
    let text = '';
    if (!interim || !waiting) {
      try {
        const asr = await load();
        // a preview gets a cap on its words (about 8 tokens a second, far above how fast anyone talks), so Whisper
        // repeating itself on a noisy stretch can't hold up the final behind it
        const r = await asr(data.audio, interim ? { max_new_tokens: Math.min(224, Math.ceil((data.audio.length / 16000) * 8) + 8) } : undefined);
        text = clean(r && r.text);
      } catch {}
    }
    postMessage({ t: 'text', id: data.id, text, interim });
  });
};
