export const INPUT_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v",
  "mpg", "mpeg", "3gp", "ts", "mts", "m2ts", "ogv", "gif"];

export const OUTPUT_FORMATS = ["MP4", "MKV", "WEBM", "AVI", "MOV", "GIF"];

export const MIME = {
  MP4: "video/mp4", MKV: "video/x-matroska", WEBM: "video/webm",
  AVI: "video/x-msvideo", MOV: "video/quicktime", GIF: "image/gif",
};

export const SPEEDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 8.0];

// WEBM uses VP8: libvpx-vp9 crashes in ffmpeg.wasm 0.12.x.
export const COMPRESSION = [
  { x264: 23, vp8: 12, mpeg4: 4, bitrate: 0.70, colors: 128, dither: "bayer:bayer_scale=3" },
  { x264: 28, vp8: 20, mpeg4: 7, bitrate: 0.50, colors: 96, dither: "none" },
  { x264: 32, vp8: 30, mpeg4: 11, bitrate: 0.35, colors: 64, dither: "none" },
  { x264: 36, vp8: 40, mpeg4: 16, bitrate: 0.20, colors: 32, dither: "none" },
];

export const RESOLUTIONS = [null, 1080, 720, 480, 360];
export const GIF_WIDTHS = [320, 480, 640, 800, null];
export const GIF_FPS = [8, 10, 12, 15, 20, 25];

export const DEFAULT_TAGS = { compress: "compressed", mute: "no-audio", none: "converted" };

const g = (n) => String(Number(n.toPrecision(6)));

export function atempoChain(speed) {
  // Each atempo filter only accepts values between 0.5 and 2.0
  const parts = [];
  let s = speed;
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${g(s)}`);
  return parts.join(",");
}

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// opts: { format, speed, compress, level, height, mute, gifWidth, gifFps, srcVbitrate }
export function buildArgs(src, dst, opts, hasAudio) {
  const fmt = opts.format;
  const speed = opts.speed;
  const compress = opts.compress;
  const level = COMPRESSION[opts.level];
  const height = opts.height;
  const mute = opts.mute || !hasAudio || fmt === "GIF";

  const args = ["-hide_banner", "-y", "-i", src];

  if (fmt === "GIF") {
    const vf = [];
    if (speed !== 1.0) vf.push(`setpts=PTS/${speed}`);
    vf.push(`fps=${opts.gifFps}`);
    if (opts.gifWidth) vf.push(`scale=${opts.gifWidth}:-1:flags=lanczos`);
    const chain = vf.join(",");
    const [colors, dither] = compress ? [level.colors, level.dither] : [256, "bayer:bayer_scale=5"];
    args.push("-filter_complex",
      `[0:v]${chain},split[a][b];` +
      `[a]palettegen=max_colors=${colors}:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
      "-loop", "0");
    return [...args, dst];
  }

  const vf = [];
  if (speed !== 1.0) vf.push(`setpts=PTS/${speed}`);
  if (height) vf.push(`scale=-2:'min(${height},ih)'`);
  else if (fmt !== "AVI") vf.push("scale=trunc(iw/2)*2:trunc(ih/2)*2"); // yuv420p needs even sides

  const sameContainer = extOf(src) === fmt.toLowerCase();
  const canCopy = !compress && speed === 1.0 && !height && sameContainer;
  // Without a cap, videos that are already compressed (WhatsApp, for example)
  // can come out larger than the original.
  const cap = compress ? Math.trunc((opts.srcVbitrate || 0) * level.bitrate) : 0;
  const capArgs = cap > 0 ? ["-maxrate", String(cap), "-bufsize", String(cap * 2)] : [];

  if (canCopy) {
    args.push("-c:v", "copy");
  } else {
    if (vf.length) args.push("-vf", vf.join(","));
    if (["MP4", "MKV", "MOV"].includes(fmt)) {
      const crf = compress ? level.x264 : 18;
      // Fast presets: ffmpeg.wasm runs on a single core.
      const preset = compress ? "medium" : "veryfast";
      args.push("-c:v", "libx264", "-crf", String(crf), "-preset", preset,
        "-pix_fmt", "yuv420p", ...capArgs);
      if (fmt !== "MKV") args.push("-movflags", "+faststart");
    } else if (fmt === "WEBM") {
      // libvpx needs -b:v as the ceiling for its CRF mode
      const crf = compress ? level.vp8 : 8;
      args.push("-c:v", "libvpx", "-crf", String(crf), "-b:v", String(cap || 8000000),
        "-deadline", "good", "-cpu-used", "4");
    } else if (fmt === "AVI") {
      const q = compress ? level.mpeg4 : 2;
      args.push("-c:v", "mpeg4", "-q:v", String(q), "-vtag", "xvid", ...capArgs);
    }
  }

  if (mute) {
    args.push("-an");
  } else {
    if (speed !== 1.0) args.push("-af", atempoChain(speed));
    if (canCopy) args.push("-c:a", "copy");
    else if (fmt === "WEBM") args.push("-c:a", "libopus", "-b:a", compress ? "96k" : "128k");
    else if (fmt === "AVI") args.push("-c:a", "libmp3lame", "-b:a", compress ? "128k" : "192k");
    else args.push("-c:a", "aac", "-b:a", compress ? "96k" : "160k");
  }

  args.push("-map", "0:v:0", ...(mute ? [] : ["-map", "0:a:0?"]));
  args.push("-sn", dst);
  return args;
}

export function outputName(srcName, opts, tags = DEFAULT_TAGS) {
  const i = srcName.lastIndexOf(".");
  const base = i > 0 ? srcName.slice(0, i) : srcName;
  const parts = [];
  if (opts.compress) parts.push(tags.compress);
  if (opts.mute && opts.format !== "GIF") parts.push(tags.mute);
  if (opts.speed !== 1.0) parts.push(`${g(opts.speed)}x`);
  if (opts.height && opts.format !== "GIF") parts.push(`${opts.height}p`);
  const suffix = "_" + (parts.length ? parts.join("_") : tags.none);
  return `${base}${suffix}.${opts.format.toLowerCase()}`;
}

export function parseProbe(json) {
  const info = { duration: 0, hasAudio: false, vbitrate: 0 };
  let data;
  try { data = JSON.parse(json || "{}"); } catch { return info; }
  const fmt = data.format || {};
  info.duration = parseFloat(fmt.duration) || 0;
  let audioBitrate = 0;
  for (const stream of data.streams || []) {
    const br = parseInt(stream.bit_rate, 10) || 0;
    if (stream.codec_type === "audio") { info.hasAudio = true; audioBitrate += br; }
    else if (stream.codec_type === "video" && !info.vbitrate) info.vbitrate = br;
  }
  if (!info.vbitrate) { // MKV and WEBM usually don't report a per-stream bitrate
    const total = parseInt(fmt.bit_rate, 10) || 0;
    info.vbitrate = Math.max(total - audioBitrate, 0);
  }
  return info;
}

export function humanSize(n) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
}

export function parseLogTime(line) {
  const m = /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}
