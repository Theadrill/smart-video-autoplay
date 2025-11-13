import { spawn, spawnSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// prettier-ignore
let URLS = [];
let INCLUDE_KEYWORDS = [];
let EXCLUDE_KEYWORDS = [];
let MIN_DURATION = 180;
let IGNORE_SHORTS = true;

// ==========================================================
// 📖 Leitura de config.json
// ==========================================================
const configPath = path.resolve("config.json");
if (!fs.existsSync(configPath)) {
    console.error("❌ config.json não encontrado!");
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const MAX_CONCURRENT_DOWNLOADS = config.maxConcurrentDownloads || 3;
const MAX_CONCURRENT_CONVERSIONS = config.maxConcurrentConversions || 2;

if (Array.isArray(config.urls)) URLS = config.urls;
if (Array.isArray(config.includeKeywords)) INCLUDE_KEYWORDS = config.includeKeywords;
if (Array.isArray(config.excludeKeywords)) EXCLUDE_KEYWORDS = config.excludeKeywords;
if (config.minDurationSeconds) MIN_DURATION = config.minDurationSeconds;
if (typeof config.ignoreShorts === "boolean") IGNORE_SHORTS = config.ignoreShorts;

// ==========================================================
// 📂 Resolve downloadsPath (incluindo queda para ./downloads)
// ==========================================================
function resolveDownloadsPath(raw) {
    const projectRoot = path.resolve("./downloads"); // pasta downloads na raiz

    // Se for array
    if (Array.isArray(raw) && raw.length > 0) {
        for (const p of raw) {
            const abs = path.resolve(p);
            if (fs.existsSync(abs)) {
                console.log(`📂 Usando pasta existente: ${abs}`);
                return abs;
            }
        }

        console.log(`⚠️ Nenhuma pasta encontrada. Criando pasta padrão na raiz: ${projectRoot}`);
        fs.mkdirSync(projectRoot, { recursive: true });
        return projectRoot;
    }

    // Se for string única
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
        console.log(`⚠️ Pasta não existe: ${resolved}`);
        console.log(`➡️ Criando pasta padrão na raiz: ${projectRoot}`);
        fs.mkdirSync(projectRoot, { recursive: true });
        return projectRoot;
    }

    return resolved;
}

const downloadsPath = resolveDownloadsPath(config.downloadsPath);
if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });

// ==========================================================
// 🔍 Se videos_cache.json não existir → executar youtubeScraper.js
// ==========================================================
const cacheFile = path.join(downloadsPath, "videos_cache.json");

if (!fs.existsSync(cacheFile)) {
    console.log("⚠️ videos_cache.json não encontrado.");
    console.log("🔄 Gerando automaticamente com youtubeScraper.js...\n");

    const scr = spawnSync("node", ["youtubeScraper.js"], { stdio: "inherit" });

    if (scr.status !== 0) {
        console.error("❌ Falha ao gerar videos_cache.json");
        process.exit(1);
    }

    console.log("✅ Cache gerado com sucesso.\n");
}

// ==========================================================
// Blacklist
// ==========================================================
const blacklistPath = path.resolve("blacklist.json");
let BLACKLIST_IDS = new Set();
try {
  if (fs.existsSync(blacklistPath)) {
    const bl = JSON.parse(fs.readFileSync(blacklistPath, "utf8"));
    if (Array.isArray(bl.videoIds)) BLACKLIST_IDS = new Set(bl.videoIds);
  }
} catch {}

// ==========================================================
// 🧠 PROGRESSO DE RETOMADA
// ==========================================================
const progressFile = path.join(downloadsPath, "downloads-progress.json");

let progress = { lastVideo: null, status: "completed" };
try {
    if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
} catch {}

function saveProgress() {
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

// ==========================================================
// Se execução anterior quebrou → limpar arquivos do vídeo interrompido
// ==========================================================
if (progress.status === "incomplete" && progress.lastVideo) {
    console.log(`⚠️ Última execução foi interrompida durante: ${progress.lastVideo}`);
    console.log("🧹 Limpando arquivos incompletos...");

    for (const f of fs.readdirSync(downloadsPath)) {
        if (f.includes(progress.lastVideo)) {
            fs.unlinkSync(path.join(downloadsPath, f));
            console.log(`  ❌ Removido: ${f}`);
        }
    }

    progress.status = "completed";
    saveProgress();
    console.log("🔁 Será reprocessado do zero quando chegar na fila.\n");
}

// ==========================================================
// Regras de divisão (sem alterar nada seu)
// ==========================================================
const DEFAULT_FINAL = Number(config.defaultFinalVideoParts ?? 0);
const MINUTES_LESS_THAN = Number(config.minutesLessThan ?? 12);
const PARTS_IF_LESS = Number(config.partsIfLess ?? 2);
const PARTS_IF_MORE = Number(config.partsIfMore ?? 3);
const MINUTES_MORE_THAN = Number(config.minutesMoreThan ?? 35);
const BIG_VIDEO_PARTS = Number(config.bigVideoParts ?? 4);

const CACHE_FILE = path.join(downloadsPath, "videos_cache.json");

// ==========================================================
// Utils (mantido igual)
// ==========================================================
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function fmtTime(sec) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// duração síncrona
function getDurationSync(filePath) {
    try {
        return Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString());
    } catch {
        return 0;
    }
}

// ==========================================================
// 🧹 LIMPEZA GLOBAL
// ==========================================================
function getBaseFromFilename(f) {
    const partMatch = f.match(/(.+?)\s+parte\s+\d+\.mp4$/i);
    if (partMatch) return partMatch[1];

    return f
        .replace(/\.orig\.mp4\.part.*$/i, "")
        .replace(/\.orig\.mp4\.ytdl$/i, "")
        .replace(/\.orig\.mp4\.temp$/i, "")
        .replace(/\.orig\.mp4$/i, "")
        .replace(/\.mp4\.part.*$/i, "")
        .replace(/\.mp4$/i, "")
        .trim();
}

function cleanupIncompleteVideos() {
    console.log("\n🧹 Verificando arquivos incompletos...");

    const files = fs.readdirSync(downloadsPath);
    const groups = {};

    for (const f of files) {
        if (!f.toLowerCase().endsWith(".mp4")
            && !f.toLowerCase().includes(".mp4.part")
            && !f.toLowerCase().includes(".orig.mp4")
            && !/parte\s+\d+\.mp4$/i.test(f)
            && !f.toLowerCase().endsWith(".ytdl")
            && !f.toLowerCase().endsWith(".temp")) {
            continue;
        }
        const base = getBaseFromFilename(f);
        if (!groups[base]) groups[base] = [];
        groups[base].push(f);
    }

    for (const base in groups) {
        const group = groups[base];

        const hasOrigPart = group.some((f) => f.toLowerCase().includes(".orig.mp4.part"));
        const hasYtdl = group.some((f) => f.toLowerCase().endsWith(".ytdl"));
        const hasTemp = group.some((f) => f.toLowerCase().endsWith(".temp"));
        const hasOrig = group.some((f) => f.toLowerCase().endsWith(".orig.mp4"));
        const hasFinalWhole = group.some((f) => f.toLowerCase().endsWith(".mp4") && !/parte\s+\d+\.mp4$/i.test(f) && !f.toLowerCase().endsWith(".orig.mp4"));
        const hasParts = group.some((f) => /parte\s+\d+\.mp4$/i.test(f));
        const hasFinalPartFragments = group.some((f) => f.toLowerCase().includes(".mp4.part"));

        // 1) Download parcial → apaga tudo
        if (hasOrigPart || hasYtdl || hasTemp) {
            console.log(`🗑️ Removendo download parcial → ${base}`);
            for (const f of group) fs.unlinkSync(path.join(downloadsPath, f));
            continue;
        }

        // 2) Orig completo sem conversão → OK
        if (hasOrig && !hasFinalWhole && !hasParts) {
            console.log(`🔁 Encontrado .orig pronto pra converter → ${base}`);
            continue;
        }

        // 3) Conversão interrompida → apagar e refazer
        if (hasFinalPartFragments) {
            console.log(`🗑️ Conversão parcial detectada → ${base}`);
            for (const f of group) fs.unlinkSync(path.join(downloadsPath, f));
            continue;
        }

        // 4) Final inteiro mas eram esperadas partes
        if (hasFinalWhole && !hasParts) {
            const finalFile = group.find((f) => f.toLowerCase().endsWith(".mp4") && !/parte\s+\d+\.mp4$/i.test(f) && !f.toLowerCase().endsWith(".orig.mp4"));
            if (finalFile) {
                const duration = getDurationSync(path.join(downloadsPath, finalFile));
                const expected = decideFinalParts(duration);
                if (expected > 1) {
                    console.log(`🗑️ Final único detectado mas eram esperadas ${expected} partes → ${base}`);
                    for (const f of group) fs.unlinkSync(path.join(downloadsPath, f));
                    continue;
                }
            }
        }
    }

    console.log("✅ Limpeza concluída.\n");
}

cleanupIncompleteVideos();

// ==========================================================
// HUD COM OFFSET
// ==========================================================
const HUD_OFFSET = 2;
let hudInitialized = false;

function initDisplay() {
    if (hudInitialized) return;
    hudInitialized = true;

    for (let i = 0; i < HUD_OFFSET; i++) console.log("");

    for (let i = 0; i < MAX_CONCURRENT_CONVERSIONS; i++) console.log("");
}

function writeAt(slot, text) {
    if (!hudInitialized) initDisplay();
    process.stdout.write("\x1b7");
    readline.cursorTo(process.stdout, 0, slot + HUD_OFFSET);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(text);
    process.stdout.write("\x1b8");
}

// ==========================================================
// PROGRESSO FFMPEG
// ==========================================================
function runFfmpegWithProgress(args, totalSeconds, labelFn, slot = 0) {
    return new Promise((resolve, reject) => {
        const spinnerFrames = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"];
        let spinIndex = 0;
        let lastTime = 0;
        const startWall = Date.now();

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

        proc.stderr.on("data", (chunk) => {
            const s = chunk.toString();
            const match = s.match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (!match) return;

            const hh = +match[1], mm = +match[2], ss = +match[3];
            lastTime = hh * 3600 + mm * 60 + ss;

            const frac = Math.min(1, lastTime / totalSeconds);
            const elapsed = (Date.now() - startWall) / 1000;
            const rate = lastTime > 0 ? lastTime / elapsed : 1;
            const rem = (totalSeconds - lastTime) / Math.max(rate, 0.01);

            const bar = `[${"■".repeat(Math.round(frac * 20))}${"□".repeat(20 - Math.round(frac * 20))}]`;
            const pct = Math.round(frac * 100);
            const spin = spinnerFrames[spinIndex++ % spinnerFrames.length];
            const label = typeof labelFn === "function" ? labelFn(lastTime) : labelFn;

            writeAt(
                slot,
                `${spin} ${label} ${bar} ${pct}% (${fmtTime(lastTime)} / ${fmtTime(totalSeconds)}) ETA: ${fmtTime(rem)} ⚡ ${rate.toFixed(2)}x`
            );
        });

        proc.on("close", (code) => {
            writeAt(slot, "");
            if (code === 0) resolve();
            else reject();
        });
    });
}

// ==========================================================
// ffprobe async
// ==========================================================
async function getDuration(filePath) {
    return new Promise((resolve) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
        let output = "";
        ffprobe.stdout.on("data", (d) => (output += d.toString()));
        ffprobe.on("close", () => resolve(parseFloat(output.trim()) || 0));
    });
}

// ==========================================================
// DOWNLOAD
// ==========================================================
async function downloadVideo(video) {
    const videoId = video.id;
    const title = sanitizeFilename(video.title);
    const channel = sanitizeFilename(video.uploader);
    const baseName = `${channel} - ${title} - ${videoId}`;
    const tempFile = path.join(downloadsPath, `${baseName}.orig.mp4`);

    progress.lastVideo = baseName;
    progress.status = "incomplete";
    saveProgress();

    console.log(`⬇️  Iniciando download: ${title}`);

    return new Promise((resolve) => {
        const proc = spawn("yt-dlp", [
            `https://www.youtube.com/watch?v=${videoId}`,
            "-f", "b[ext=mp4]",
            "-o", tempFile,
            "--no-overwrites"
        ]);

        proc.on("close", async (code) => {
            if (code !== 0) return resolve(null);

            const duration = await getDuration(tempFile);
            if (duration < MIN_DURATION) {
                fs.unlinkSync(tempFile);
                return resolve(null);
            }

            console.log(`✅ Download concluído: ${title}`);
            resolve({ tempFile, baseName, duration });
        });
    });
}

// ==========================================================
// Final Parts
// ==========================================================
function decideFinalParts(totalSeconds) {
    if (DEFAULT_FINAL > 0) return DEFAULT_FINAL;

    const minutes = totalSeconds / 60;
    if (minutes >= MINUTES_MORE_THAN) return BIG_VIDEO_PARTS;
    if (minutes < MINUTES_LESS_THAN) return PARTS_IF_LESS;
    return PARTS_IF_MORE;
}

// ==========================================================
// Convert + Split
// ==========================================================
async function convertAndSplit(task) {
    const { tempFile, baseName, duration, slot } = task;
    const finalFile = path.join(downloadsPath, `${baseName}.mp4`);

    await runFfmpegWithProgress(
        [
            "-y",
            "-i", tempFile,
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "30",
            "-vf", "scale='min(1280,iw)':-2",
            "-movflags", "+faststart",
            finalFile
        ],
        duration,
        () => `🎞️ Convertendo ${baseName}`,
        slot
    );

    const finalParts = decideFinalParts(duration);

    if (finalParts <= 1) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        progress.status = "completed";
        saveProgress();
        return true;
    }

    const segment = duration / finalParts;

    for (let i = 0; i < finalParts; i++) {
        const start = Math.floor(i * segment);
        const dur = i === finalParts - 1 ? Math.ceil(duration - start) : Math.ceil(segment);
        const out = path.join(downloadsPath, `${baseName} parte ${i + 1}.mp4`);

        await runFfmpegWithProgress(
            ["-y", "-ss", String(start), "-t", String(dur), "-i", finalFile, "-c", "copy", out],
            dur,
            () => `✂️ Parte ${i + 1}/${finalParts} — ${baseName}`,
            slot
        );
    }

    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);

    progress.status = "completed";
    saveProgress();
    return true;
}

// ==========================================================
// Execução principal
// ==========================================================
(async () => {
    initDisplay();

    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

    const allVideos = Object.values(cache)
        .flat()
        .filter(v => !BLACKLIST_IDS.has(v.id));

    console.log(`📦 Total de vídeos na fila: ${allVideos.length}\n`);

    const downloadQueue = [...allVideos];
    const conversionQueue = [];
    let concluidos = 0;

    async function downloadWorker() {
        while (downloadQueue.length > 0) {
            const v = downloadQueue.shift();
            const r = await downloadVideo(v);
            if (r) conversionQueue.push(r);
        }
    }

    async function conversionWorker(slot) {
        while (true) {
            const task = conversionQueue.shift();
            if (!task) {
                await new Promise((r) => setTimeout(r, 800));
                if (downloadQueue.length === 0 && conversionQueue.length === 0) break;
                continue;
            }
            task.slot = slot;
            const ok = await convertAndSplit(task);
            if (ok) concluidos++;
        }
    }

    const downloaders = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, downloadWorker);
    const converters = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, (_, i) => conversionWorker(i));

    await Promise.all([...downloaders, ...converters]);

    console.log(`\n✅ Concluídos: ${concluidos}`);
})();
