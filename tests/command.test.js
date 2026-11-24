import assert from "assert";
import { atempoChain, buildArgs, outputName, parseProbe, parseLogTime, fmtTime } from "../js/command.js";
import { STRINGS } from "../js/i18n.js";

const base = { format: "MP4", speed: 1.0, compress: false, level: 1, height: null, mute: false,
  gifWidth: 320, gifFps: 10, srcVbitrate: 2000000 };
let count = 0;
const test = (name, fn) => { fn(); count++; console.log("ok -", name); };

test("atempo splits values outside 0.5–2", () => {
  assert.strictEqual(atempoChain(8), "atempo=2.0,atempo=2.0,atempo=2");
  assert.strictEqual(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.strictEqual(atempoChain(1.5), "atempo=1.5");
});

test("same container with no changes copies without re-encoding", () => {
  const a = buildArgs("v.mp4", "o.mp4", { ...base, mute: true }, true);
  assert.ok(a.join(" ").includes("-c:v copy"));
  assert.ok(a.includes("-an"));
});

test("compression uses the level's CRF and a bitrate cap", () => {
  const a = buildArgs("v.mp4", "o.mp4", { ...base, compress: true, level: 1 }, true).join(" ");
  assert.ok(a.includes("-crf 28"));
  assert.ok(a.includes("-maxrate 1000000 -bufsize 2000000"));
  assert.ok(a.includes("-c:a aac -b:a 96k"));
});

test("speed changes both video and audio", () => {
  const a = buildArgs("v.mkv", "o.webm", { ...base, format: "WEBM", speed: 2 }, true).join(" ");
  assert.ok(a.includes("setpts=PTS/2"));
  assert.ok(a.includes("-af atempo=2"));
  assert.ok(a.includes("-c:v libvpx -crf 8") && a.includes("libopus"));
});

test("GIF uses a palette and never has audio", () => {
  const a = buildArgs("v.mp4", "o.gif", { ...base, format: "GIF", compress: true, level: 2 }, true).join(" ");
  assert.ok(a.includes("palettegen=max_colors=64"));
  assert.ok(a.includes("scale=320:-1"));
  assert.ok(!a.includes("-c:a"));
});

test("output name follows the UI language", () => {
  assert.strictEqual(outputName("beach.mov", { ...base, compress: true, speed: 2, height: 720 }),
    "beach_compressed_2x_720p.mp4");
  assert.strictEqual(outputName("beach.mov", base), "beach_converted.mp4");
  assert.strictEqual(outputName("praia.mov", { ...base, compress: true, mute: true }, STRINGS.pt.tags),
    "praia_comprimido_sem-audio.mp4");
});

test("parses ffprobe JSON", () => {
  const info = parseProbe(JSON.stringify({ format: { duration: "20.5", bit_rate: "3000000" },
    streams: [{ codec_type: "video" }, { codec_type: "audio", bit_rate: "128000" }] }));
  assert.deepStrictEqual(info, { duration: 20.5, hasAudio: true, vbitrate: 2872000 });
});

test("parses time from the ffmpeg log", () => {
  assert.strictEqual(parseLogTime("frame=  50 fps=12 q=28.0 size=  256kB time=00:01:02.50 bitrate="), 62.5);
  assert.strictEqual(parseLogTime("Stream #0:0"), null);
  assert.strictEqual(fmtTime(3725), "01:02:05");
});

test("every language has every key", () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const [code, strings] of Object.entries(STRINGS)) {
    assert.deepStrictEqual(Object.keys(strings).sort(), keys, `language "${code}"`);
    assert.strictEqual(strings.speeds.length, 10, `${code}.speeds`);
    assert.strictEqual(strings.levels.length, 4, `${code}.levels`);
  }
});

console.log(`\n${count} tests passed`);
