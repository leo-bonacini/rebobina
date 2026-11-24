import { FFmpeg } from "../vendor/ffmpeg/index.js";
import {
  INPUT_EXTS, OUTPUT_FORMATS, MIME, SPEEDS, RESOLUTIONS, GIF_WIDTHS, GIF_FPS,
  buildArgs, outputName, parseProbe, humanSize, fmtTime, parseLogTime, extOf,
} from "./command.js";
import { LANGUAGES, STRINGS, initialLanguage } from "./i18n.js";

// Single-threaded core: the multi-threaded one needs COOP/COEP headers, which GitHub Pages can't send.
const CORE_VERSION = "0.12.10";
const CORE_CDNS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];
const WASM_SIZE_HINT = 32 * 1024 * 1024;
const GIF_LIMIT = 25 * 1024 * 1024;

const COUNTER_API = "https://abacus.jasoncameron.dev";
// Empty: derived from <user>.github.io/<repo>, and off on any other host.
const COUNTER_NAMESPACE = "";

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $("dropzone"), fileInput: $("file-input"), dropzoneText: $("dropzone-text"),
  fileInfo: $("file-info"), speed: $("speed"), resolution: $("resolution"),
  compress: $("compress"), mute: $("mute"), level: $("level"), format: $("format"),
  gifOptions: $("gif-options"), gifWidth: $("gif-width"), gifFps: $("gif-fps"),
  outputName: $("output-name"), gifTip: $("gif-tip"), progress: $("progress"),
  progressFill: $("progress-fill"), progressText: $("progress-text"), showLog: $("show-log"),
  log: $("log"), status: $("status"), download: $("download"), start: $("start"),
  language: $("language"), theme: $("theme"), counter: $("counter"),
};

const state = {
  file: null, info: null, busy: false, cancelled: false,
  analyzing: false, nameEdited: false, resultUrl: null, ffmpeg: null, coreUrls: null,
  // [key, ...args] instead of text, so they can be re-rendered in another language
  progressMsg: ["ready"], statusMsg: null, statusError: false, infoMsgs: [],
  users: null, conversions: null,
};

const storage = {
  get(key) { try { return localStorage.getItem(`rebobina-${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`rebobina-${key}`, value); } catch {} },
};

let lang = initialLanguage(storage.get("lang"));
let T = STRINGS[lang];

function tr(msg) {
  if (msg == null) return "";
  if (!Array.isArray(msg)) return msg;
  const [key, ...args] = msg;
  const value = T[key];
  return typeof value === "function" ? value(...args) : value;
}

function fill(select, labels, defaultIndex) {
  const selected = select.options.length ? +select.value : defaultIndex;
  select.innerHTML = "";
  labels.forEach((label, i) => select.add(new Option(label, String(i), i === selected, i === selected)));
}

const sizeLabel = (value, unit) => (value ? `${value}${unit}` : T.original);

function applyLanguage() {
  document.documentElement.lang = { en: "en", pt: "pt-BR", es: "es" }[lang];
  document.querySelector('meta[name="description"]').content = T.description;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = T[node.dataset.i18n];
  if (!state.file) {
    for (const node of document.querySelectorAll("[data-i18n-html]")) node.innerHTML = T[node.dataset.i18nHtml];
  }
  el.language.setAttribute("aria-label", T.language);
  el.theme.setAttribute("aria-label", T.themeLabel);
  fill(el.speed, T.speeds, SPEEDS.indexOf(1.0));
  fill(el.resolution, RESOLUTIONS.map((h) => sizeLabel(h, "p")), 0);
  fill(el.level, T.levels, 1);
  fill(el.gifWidth, GIF_WIDTHS.map((w) => sizeLabel(w, " px")), 0);
  applyTheme();
  renderMessages();
  renderCounter();
  refresh();
}

fill(el.format, OUTPUT_FORMATS, 0);
fill(el.gifFps, GIF_FPS.map((f) => `${f} fps`), 1);
for (const [code, name] of Object.entries(LANGUAGES)) {
  el.language.add(new Option(name, code, code === lang, code === lang));
}
el.language.addEventListener("change", () => {
  lang = el.language.value;
  T = STRINGS[lang];
  storage.set("lang", lang);
  applyLanguage();
});
el.compress.checked = true;

const THEMES = ["auto", "light", "dark"];
let theme = THEMES.includes(storage.get("theme")) ? storage.get("theme") : "auto";

function applyTheme() {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  el.theme.textContent = T.theme[theme];
}
el.theme.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  storage.set("theme", theme);
  applyTheme();
});

function options() {
  return {
    format: OUTPUT_FORMATS[+el.format.value],
    speed: SPEEDS[+el.speed.value],
    compress: el.compress.checked,
    level: +el.level.value,
    height: RESOLUTIONS[+el.resolution.value],
    mute: el.mute.checked,
    gifWidth: GIF_WIDTHS[+el.gifWidth.value],
    gifFps: GIF_FPS[+el.gifFps.value],
    srcVbitrate: state.info ? state.info.vbitrate : 0,
  };
}

function refresh() {
  const isGif = OUTPUT_FORMATS[+el.format.value] === "GIF";
  const busy = state.busy;
  el.gifOptions.hidden = !isGif;
  el.gifTip.hidden = !isGif;
  for (const control of [el.speed, el.format, el.compress, el.gifWidth, el.gifFps, el.outputName]) {
    control.disabled = busy;
  }
  el.fileInput.disabled = busy;
  el.level.disabled = busy || !el.compress.checked;
  el.mute.disabled = busy || isGif || !(state.info && state.info.hasAudio);
  el.resolution.disabled = busy || isGif;
  el.start.disabled = !state.file || state.analyzing;
  el.start.textContent = busy ? T.cancel : T.start;
  if (state.file && !state.nameEdited) el.outputName.value = outputName(state.file.name, options(), T.tags);
}

for (const control of [el.speed, el.resolution, el.compress, el.mute, el.level, el.format,
  el.gifWidth, el.gifFps]) {
  control.addEventListener("change", () => { clearResult(); refresh(); });
}
el.outputName.addEventListener("input", () => { state.nameEdited = el.outputName.value.trim() !== ""; });
el.showLog.addEventListener("change", () => { el.log.hidden = !el.showLog.checked; });

function renderMessages() {
  el.progressText.textContent = tr(state.progressMsg);
  el.status.textContent = tr(state.statusMsg);
  el.status.classList.toggle("error", state.statusError);
  el.fileInfo.textContent = state.infoMsgs.map(tr).join(" · ");
}
function setProgress(percent, msg) {
  el.progressFill.classList.toggle("indeterminate", percent == null);
  el.progressFill.style.width = percent == null ? "" : `${percent}%`;
  el.progress.setAttribute("aria-valuenow", String(Math.round(percent || 0)));
  state.progressMsg = msg;
  el.progressText.textContent = tr(msg);
}
function setStatus(msg, isError = false) {
  state.statusMsg = msg;
  state.statusError = isError;
  el.status.textContent = tr(msg);
  el.status.classList.toggle("error", isError);
}
function setInfo(...msgs) {
  state.infoMsgs = msgs;
  el.fileInfo.textContent = msgs.map(tr).join(" · ");
}
const logLines = [];
function log(text) {
  logLines.push(text);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  el.log.textContent = logLines.join("\n");
  el.log.scrollTop = el.log.scrollHeight;
}
function clearLog() { logLines.length = 0; el.log.textContent = ""; }

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  el.download.hidden = true;
}

function counterNamespace() {
  if (COUNTER_NAMESPACE) return COUNTER_NAMESPACE;
  const testName = new URLSearchParams(location.search).get("counter");
  if (testName && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return testName;
  const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return "";
  const repo = location.pathname.split("/").filter(Boolean)[0] || "site";
  return `${m[1]}-${repo}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 64);
}
const NAMESPACE = counterNamespace();

async function counterRequest(action, key) {
  const res = await fetch(`${COUNTER_API}/${action}/${NAMESPACE}/${key}`, { cache: "no-store" });
  if (res.status === 404) return 0; // key not created yet
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).value;
}

function renderCounter() {
  if (state.users == null) return;
  const nf = new Intl.NumberFormat(document.documentElement.lang);
  el.counter.textContent = T.counter(nf.format(state.users), nf.format(state.conversions || 0));
  el.counter.hidden = false;
}

async function startCounter() {
  if (!NAMESPACE) return;
  try {
    // A browser counts as a person once; later visits only read the total
    const isNew = !storage.get("counted");
    const [users, conversions] = await Promise.all([
      counterRequest(isNew ? "hit" : "get", "users"),
      counterRequest("get", "conversions"),
    ]);
    if (isNew) storage.set("counted", "1");
    state.users = Math.max(users, 1);
    state.conversions = conversions;
    renderCounter();
  } catch {}
}

async function countConversion() {
  if (!NAMESPACE) return;
  try {
    state.conversions = await counterRequest("hit", "conversions");
    renderCounter();
  } catch {}
}

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, total);
  }
  return new Blob(chunks);
}

async function downloadCore() {
  let lastError;
  for (const base of CORE_CDNS) {
    try {
      const js = await fetchWithProgress(`${base}/ffmpeg-core.js`, () => {});
      const wasm = await fetchWithProgress(`${base}/ffmpeg-core.wasm`, (received, total) => {
        // With gzip/brotli, content-length is the compressed size
        const size = total > received && total > WASM_SIZE_HINT / 2
          ? total : Math.max(WASM_SIZE_HINT, received);
        setProgress(Math.min(99, received / size * 100),
          ["downloadingFfmpeg", humanSize(received), humanSize(size)]);
      });
      return {
        coreURL: URL.createObjectURL(new Blob([js], { type: "text/javascript" })),
        wasmURL: URL.createObjectURL(new Blob([wasm], { type: "application/wasm" })),
      };
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

let onLogLine = null;
async function getFFmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  if (!state.coreUrls) state.coreUrls = await downloadCore();
  setProgress(null, ["startingFfmpeg"]);
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => { log(message); if (onLogLine) onLogLine(message); });
  await ff.load(state.coreUrls);
  state.ffmpeg = ff;
  return ff;
}

// WORKERFS reads the File in place instead of copying it into wasm memory.
async function mountInput(ff, file) {
  try { await ff.createDir("/in"); } catch {}
  try {
    await ff.mount("WORKERFS", { files: [file] }, "/in");
    return { path: `/in/${file.name}`, mounted: true };
  } catch {
    const path = `/input.${extOf(file.name) || "bin"}`;
    await ff.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return { path, mounted: false };
  }
}
async function releaseInput(ff, input) {
  try {
    if (input.mounted) await ff.unmount("/in");
    else await ff.deleteFile(input.path);
  } catch {}
}

async function loadFile(file) {
  if (state.busy || !file) return;
  const ext = extOf(file.name);
  if (!INPUT_EXTS.includes(ext) && !file.type.startsWith("video/")) {
    setStatus(["unsupported", ext || "?"], true);
    return;
  }
  clearResult();
  state.file = file;
  state.info = null;
  state.nameEdited = false;
  el.dropzoneText.textContent = file.name;
  setInfo(humanSize(file.size), ["analyzing"]);
  setStatus(null);

  state.busy = true;
  state.analyzing = true;
  refresh();
  try {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, file);
    await ff.ffprobe(["-v", "error", "-show_entries",
      "format=duration,bit_rate:stream=codec_type,bit_rate",
      "-of", "json", input.path, "-o", "/probe.json"]);
    const json = await ff.readFile("/probe.json", "utf8").catch(() => "");
    await ff.deleteFile("/probe.json").catch(() => {});
    await releaseInput(ff, input);
    state.info = parseProbe(json);
    const parts = [humanSize(file.size)];
    if (state.info.duration) parts.push(["duration", fmtTime(state.info.duration)]);
    parts.push([state.info.hasAudio ? "withAudio" : "noAudio"]);
    setInfo(...parts);
    if (file.size > 1.5 * 1024 ** 3) setStatus(["tooLarge"], true);
    setProgress(0, ["ready"]);
  } catch (e) {
    setInfo(humanSize(file.size));
    setProgress(0, ["error"]);
    setStatus(["loadFailed", e.message || String(e)], true);
  } finally {
    state.busy = false;
    state.analyzing = false;
    if (!state.info?.hasAudio) el.mute.checked = false;
    refresh();
  }
}

el.fileInput.addEventListener("change", () => loadFile(el.fileInput.files[0]));
el.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); el.dropzone.classList.add("dragging"); });
el.dropzone.addEventListener("dragleave", () => el.dropzone.classList.remove("dragging"));
el.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  el.dropzone.classList.remove("dragging");
  loadFile(e.dataTransfer.files[0]);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

async function start() {
  const file = state.file;
  const opts = options();
  const ext = opts.format.toLowerCase();
  let outName = el.outputName.value.trim() || outputName(file.name, opts, T.tags);
  if (extOf(outName) !== ext) outName += `.${ext}`;
  const outPath = `/output.${ext}`;

  clearResult();
  clearLog();
  state.busy = true;
  state.cancelled = false;
  refresh();
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  const outDuration = state.info?.duration ? state.info.duration / opts.speed : 0;

  try {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, file);
    const args = buildArgs(input.path, outPath, opts, !!state.info?.hasAudio);
    log("$ ffmpeg " + args.map((a) => (/[\s;']/.test(a) ? `"${a}"` : a)).join(" ") + "\n");
    setProgress(0, "0%");
    setStatus(["processing"]);
    onLogLine = (line) => {
      const t = parseLogTime(line);
      if (t == null || !outDuration) return;
      const fraction = Math.min(t / outDuration, 1);
      const left = fraction > 0.01 ? elapsed() / fraction - elapsed() : 0;
      setProgress(fraction * 100, `${Math.floor(fraction * 100)}%`);
      setStatus(left ? ["timeLeft", fmtTime(left)] : ["processing"]);
    };
    if (!outDuration) setProgress(null, ["processing"]);

    // The earlier ffprobe call leaves the log level at "error" in this instance,
    // which would hide the time= lines the progress bar reads.
    const code = await ff.exec(["-loglevel", "info", ...args]);
    onLogLine = null;
    await releaseInput(ff, input);
    if (code !== 0) throw new Error(`ffmpeg exit code ${code}`);

    const data = await ff.readFile(outPath);
    await ff.deleteFile(outPath).catch(() => {});
    const blob = new Blob([data], { type: MIME[opts.format] });
    state.resultUrl = URL.createObjectURL(blob);
    el.download.href = state.resultUrl;
    el.download.download = outName;
    el.download.hidden = false;

    const diff = file.size ? (1 - blob.size / file.size) * 100 : 0;
    const change = diff >= 0 ? `-${diff.toFixed(0)}%` : `+${(-diff).toFixed(0)}%`;
    const result = ["result", humanSize(blob.size), change, fmtTime(elapsed())];
    setProgress(100, ["done"]);
    if (opts.format === "GIF" && blob.size > GIF_LIMIT) setStatus(`${tr(result)}. ${T.gifTooLarge}`, true);
    else setStatus(result);
    countConversion();
  } catch (e) {
    onLogLine = null;
    if (state.cancelled) {
      setProgress(0, ["cancelled"]);
      setStatus(["operationCancelled"]);
    } else {
      // A crashed instance is unusable, so the next run loads a fresh one
      state.ffmpeg?.terminate();
      state.ffmpeg = null;
      setProgress(0, ["error"]);
      setStatus(["failed"], true);
      log(`\nError: ${e.message || e}`);
    }
  } finally {
    state.busy = false;
    refresh();
  }
}

function cancel() {
  state.cancelled = true;
  // ffmpeg.wasm has no way to stop exec() other than killing the worker
  state.ffmpeg?.terminate();
  state.ffmpeg = null;
}

el.start.addEventListener("click", () => {
  if (state.busy) cancel();
  else if (state.file) start();
});

(() => {
  const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return;
  const repo = location.pathname.split("/").filter(Boolean)[0] || `${m[1]}.github.io`;
  $("link-source").href = `https://github.com/${m[1]}/${repo}`;
})();

window.addEventListener("beforeunload", (e) => { if (state.busy) e.preventDefault(); });

applyLanguage();
startCounter();
