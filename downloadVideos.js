import { spawn, spawnSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// prettier-ignore
let URLS = [];
let INCLUDE_KEYWORDS = [];
let EXCLUDE_KEYWORDS = [];
let MIN_DURATION = 180;
let IGNORE_SHORTS = true;

// ==========================================================
// 📖 Lê config.json
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
// 📂 Resolve downloadsPath
// ==========================================================
function resolveDownloadsPath(raw) {
    const projectRoot = path.resolve("./downloads");

    if (Array.isArray(raw) && raw.length > 0) {
        for (const p of raw) {
            const abs = path.resolve(p);
            if (fs.existsSync(abs)) return abs;
        }
        fs.mkdirSync(projectRoot, { recursive: true });
        return projectRoot;
    }

    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
        fs.mkdirSync(projectRoot, { recursive: true });
        return projectRoot;
    }
    return resolved;
}

const downloadsPath = resolveDownloadsPath(config.downloadsPath);
if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });

// ==========================================================
// 🔍 Cache
// ==========================================================
const cacheFile = path.join(downloadsPath, "videos_cache.json");

if (!fs.existsSync(cacheFile)) {
    console.log("⚠️ videos_cache.json não encontrado.");
    console.log("🔄 Gerando automaticamente...\n");

    const scr = spawnSync("node", ["youtubeScraper.js", downloadsPath], { stdio: "inherit" });

    if (scr.status !== 0) {
        console.error("❌ Falha ao gerar cache.");
        process.exit(1);
    }
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
// Progresso
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
// Limpa vídeos quebrados da execução anterior
// ==========================================================
if (progress.status === "incomplete" && progress.lastVideo) {
    console.log(`⚠️ Execução anterior interrompida: ${progress.lastVideo}`);
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
// Utils
// ==========================================================
function sanitizeFilename(str) {
    if (!str) return "video";
    str = str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
    str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    str = str.replace(/[<>:"/\\|?*\x00-\x1F]/g, "");
    str = str.replace(/\s+/g, " ").trim();
    return str || "video";
}

function fmtTime(sec) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

async function getDuration(filePath) {
    return new Promise((resolve) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
        let out = "";
        ffprobe.stdout.on("data", (d) => (out += d.toString()));
        ffprobe.on("close", () => resolve(parseFloat(out.trim()) || 0));
    });
}

// ==========================================================
// FFMPEG — sem HUD, progresso simples
// ==========================================================
function runFfmpegSimple(label, args) {
    return new Promise((resolve, reject) => {
        console.log(label);

        const proc = spawn("ffmpeg", args);

        proc.stderr.on("data", (chunk) => {
            const s = chunk.toString();
            const t = s.match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (t) {
                process.stdout.write(`   ⏱️ ${t[1]}:${t[2]}:${t[3]}\r`);
            }
        });

        proc.on("close", (code) => {
            process.stdout.write("\n");
            if (code === 0) resolve();
            else reject();
        });
    });
}

// ==========================================================
// DOWNLOAD — log mínimo
// ==========================================================
async function downloadVideo(video, index, total) {
    const videoId = video.id;
    const title = sanitizeFilename(video.title);
    const channel = sanitizeFilename(video.uploader);
    const baseName = `${channel} - ${title} - ${videoId}`;
    const tempFile = path.join(downloadsPath, `${baseName}.orig.mp4`);

    // ==========================================================
// 🛑 Se o vídeo já existe (final ou partes), não baixar
// ==========================================================
const baseFinal = path.join(downloadsPath, `${baseName}.mp4`);
const existingParts = fs.readdirSync(downloadsPath)
    .filter(f => f.startsWith(baseName) && f.match(/parte\s+\d+\.mp4$/i));

if (fs.existsSync(baseFinal)) {
    console.log(`⏭️ Já existe (final): ${title}`);
    return null;
}

if (existingParts.length > 0) {
    console.log(`⏭️ Já existe (partes): ${title}`);
    return null;
}


    progress.lastVideo = baseName;
    progress.status = "incomplete";
    saveProgress();

    console.log(`⬇️ Baixando (${index}/${total}): ${title}`);

    const formatSelector = "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/b[ext=mp4][height<=720]";

    const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        "-f", formatSelector,
        "-o", tempFile,
        "--no-overwrites",
        "--cookies", "cookies.txt",
        "--extractor-args", "youtube:player_client=android"
    ];

    return new Promise((resolve) => {
        const proc = spawn("yt-dlp", args);

        // yt-dlp silencioso
        proc.stdout.on("data", () => {});
        proc.stderr.on("data", () => {});

        proc.on("close", async (code) => {
            if (code !== 0 || !fs.existsSync(tempFile)) return resolve(null);

            const duration = await getDuration(tempFile);
            if (duration < MIN_DURATION) {
                fs.unlinkSync(tempFile);
                return resolve(null);
            }

            resolve({ tempFile, baseName, duration });
        });
    });
}

// ==========================================================
// Decide quantas partes deve cortar
// ==========================================================
function decideFinalParts(totalSeconds) {
    const minutes = totalSeconds / 60;

    if (config.defaultFinalVideoParts > 0)
        return Number(config.defaultFinalVideoParts);

    if (minutes >= Number(config.minutesMoreThan ?? 35))
        return Number(config.bigVideoParts ?? 4);

    if (minutes < Number(config.minutesLessThan ?? 12))
        return Number(config.partsIfLess ?? 2);

    return Number(config.partsIfMore ?? 3);
}

// ==========================================================
// Conversão + Split — log limpo
// ==========================================================
async function convertAndSplit(task) {
    const { tempFile, baseName, duration } = task;
    const finalFile = path.join(downloadsPath, `${baseName}.mp4`);

    await runFfmpegSimple(
        `🎞️ Convertendo: ${baseName}`,
        [
            "-y", "-i", tempFile,
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "30",
            "-vf", "scale='min(1280,iw)':-2",
            "-movflags", "+faststart",
            finalFile
        ]
    );

    const parts = decideFinalParts(duration);

    if (parts <= 1) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        progress.status = "completed";
        saveProgress();
        return true;
    }

    const segment = duration / parts;

    for (let i = 0; i < parts; i++) {
        const start = Math.floor(i * segment);
        const dur = i === parts - 1 ? Math.ceil(duration - start) : Math.ceil(segment);
        const out = path.join(downloadsPath, `${baseName} parte ${i + 1}.mp4`);

        await runFfmpegSimple(
            `✂️ Cortando parte ${i + 1}/${parts}: ${baseName}`,
            ["-y", "-ss", String(start), "-t", String(dur),
             "-i", finalFile, "-c", "copy", out]
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
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const allVideos = Object.values(cache)
        .flat()
        .filter(v => !BLACKLIST_IDS.has(v.id));

    console.log(`📦 Total de vídeos na fila: ${allVideos.length}\n`);

    const downloadQueue = [...allVideos];
    const conversionQueue = [];
    let concluidos = 0;
    let index = 0;

    async function downloadWorker() {
        while (downloadQueue.length > 0) {
            const v = downloadQueue.shift();
            index++;
            const r = await downloadVideo(v, index, allVideos.length);
            if (r) conversionQueue.push(r);
        }
    }

    async function conversionWorker() {
        while (true) {
            const task = conversionQueue.shift();
            if (!task) {
                await new Promise(r => setTimeout(r, 800));
                if (downloadQueue.length === 0 && conversionQueue.length === 0)
                    break;
                continue;
            }
            const ok = await convertAndSplit(task);
            if (ok) concluidos++;
        }
    }

    const downloaders = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, downloadWorker);
    const converters = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, conversionWorker);

    await Promise.all([...downloaders, ...converters]);

    console.log(`\n✅ Concluídos: ${concluidos}`);
})();
