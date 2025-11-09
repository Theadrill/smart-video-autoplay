import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import https from "https"
import readline from "readline"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const VERBOSE = true
const vlog = (...a) => VERBOSE && console.log(`[${new Date().toISOString()}]`, ...a)
const verror = (...a) => console.error(`[${new Date().toISOString()}] ❌`, ...a)

// ===================== CONFIG =====================
const configPath = path.resolve("config.json")
if (!fs.existsSync(configPath)) {
    verror("config.json não encontrado.")
    process.exit(1)
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"))

let URLS = config.urls || []
let INCLUDE_KEYWORDS = config.includeKeywords || []
let EXCLUDE_KEYWORDS = config.excludeKeywords || []
let MIN_DURATION = config.minDurationSeconds || 180
let IGNORE_SHORTS = config.ignoreShorts ?? true

const MAX_CONCURRENT_DOWNLOADS = config.maxConcurrentDownloads || 3
const MAX_CONCURRENT_CONVERSIONS = config.maxConcurrentConversions || 2

const MINUTES_LESS_THAN = config.minutesLessThan ?? 12
const PARTS_IF_LESS = config.partsIfLess ?? 2
const PARTS_IF_MORE = config.partsIfMore ?? 3
const MINUTES_MORE_THAN = config.minutesMoreThan ?? 35
const BIG_VIDEO_PARTS = config.bigVideoParts ?? 4

// ===================== DOWNLOADS PATH =====================
function resolveDownloadsPath(raw) {
    if (Array.isArray(raw)) {
        for (const p of raw) {
            const abs = path.resolve(p)
            if (abs.toUpperCase().includes("VIDEOS PARA TELÃO")) return abs
        }
        return path.resolve(raw[0])
    }
    const abs = path.resolve(raw)
    if (abs.toUpperCase().includes("VIDEOS PARA TELÃO")) return abs
    return path.resolve("./downloads")
}

let downloadsPath = resolveDownloadsPath(config.downloadsPath)
if (!fs.existsSync(downloadsPath)) {
    console.log(`📁 Criando pasta de downloads: ${downloadsPath}`)
    fs.mkdirSync(downloadsPath, { recursive: true })
} else {
    vlog("Pasta verificada:", downloadsPath)
}

const CACHE_FILE = path.join(downloadsPath, "videos_cache.json")

// ===================== LOGS =====================
const logsDir = path.resolve("logs")
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
const ERROR_LOG = path.join(logsDir, "error.log")
const DOWNLOAD_LOG = path.join(logsDir, "download.log")
const CONVERSION_LOG = path.join(logsDir, "conversion.log")

function logTo(file, text) {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`)
}

// ===================== HUD =====================
let HUD_INITIALIZED = false
const HUD_OFFSET = 2
function initHUD() {
    if (HUD_INITIALIZED) return
    HUD_INITIALIZED = true
    console.log("\n".repeat(HUD_OFFSET + MAX_CONCURRENT_CONVERSIONS))
}
function HUD(slot, text) {
    initHUD()
    process.stdout.write("\x1b7")
    readline.cursorTo(process.stdout, 0, HUD_OFFSET + slot)
    readline.clearLine(process.stdout, 0)
    process.stdout.write(text)
    process.stdout.write("\x1b8")
}

// ===================== HELPERS =====================
function sanitize(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, " ").trim()
}
function loadCache() { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : null }
function saveCache(c) { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)) }

// ===================== GET CHANNEL NAME =====================
async function getChannelName(url) {
    return new Promise((resolve) => {
        let u = url.replace("/@", "/")
        if (!u.endsWith("/")) u += "/"
        https.get(u, res => {
            let d = ""
            res.on("data", c => d += c)
            res.on("end", () => {
                const m = d.match(/<title>(.*?)<\/title>/i)
                resolve(m ? m[1].replace("- YouTube", "").trim() : "Canal Desconhecido")
            })
        }).on("error", () => resolve("Canal Desconhecido"))
    })
}

// ===================== COLLECT VIDEOS =====================
async function collectVideos() {
    const cache = {}
    for (const url of URLS) {
        console.log(`\n🔍 Coletando vídeos de: ${url}`)
        const channel = sanitize(await getChannelName(url))
        const tmp = path.join(downloadsPath, "tmp_list.json")
        execSync(`yt-dlp -j --flat-playlist "${url}" > "${tmp}" 2>&1`)
        const entries = fs.readFileSync(tmp, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
        fs.unlinkSync(tmp)
        const inc = INCLUDE_KEYWORDS.map(k => k.toLowerCase())
        const exc = EXCLUDE_KEYWORDS.map(k => k.toLowerCase())
        const filtered = entries.filter(v => {
            const t = (v.title || "").toLowerCase()
            const includeOK = inc.length === 0 || inc.some(k => t.includes(k))
            const excludeOK = exc.length === 0 || !exc.some(k => t.includes(k))
            const isShort = IGNORE_SHORTS && (t.includes("shorts") || (v.duration && v.duration < 60))
            return includeOK && excludeOK && !isShort
        })
        cache[url] = filtered.map(v => ({
            id: v.id,
            title: v.title,
            uploader: channel
        }))
    }
    saveCache(cache)
    return cache
}

// ===================== DOWNLOAD VIDEO =====================
async function getDuration(file) {
    return new Promise(res => {
        const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
        let out = ""
        p.stdout.on("data", d => out += d)
        p.on("close", () => res(parseFloat(out) || 0))
    })
}

async function downloadVideo(v) {
    const base = `${sanitize(v.uploader)} - ${sanitize(v.title)} - ${v.id}`
    const temp = path.join(downloadsPath, `${base}.orig.mp4`)
    console.log(`\n⬇️ Baixando: ${base}`)
    const p = spawn("yt-dlp", [`https://www.youtube.com/watch?v=${v.id}`, "-f", "b[ext=mp4]", "-o", temp, "--newline", "--verbose"])
    p.stdout.on('data', (data) => {
        console.log(data.toString());
    });
    p.stderr.on('data', (data) => {
        console.error(data.toString());
    });
    return new Promise(resolve => {
        p.on("close", async () => {
            if (!fs.existsSync(temp)) return resolve(null)
            const dur = await getDuration(temp)
            if (dur < MIN_DURATION) { fs.unlinkSync(temp); return resolve(null) }
            resolve({ base, temp, dur })
        })
    })
}

// ===================== SPLIT LOGIC =====================
function decideParts(sec) {
    const min = sec / 60
    return min < MINUTES_LESS_THAN ? PARTS_IF_LESS
         : min >= MINUTES_MORE_THAN ? BIG_VIDEO_PARTS
         : PARTS_IF_MORE
}

async function convertAndSplit(job, slot) {
    const { base, temp, dur } = job
    const final = path.join(downloadsPath, `${base}.mp4`)

    // Convert
    const c = spawn("ffmpeg", ["-y", "-i", temp, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", final])
    c.stderr.on("data", d => {
        const m = d.toString().match(/time=(\d+):(\d+):(\d+)/)
        if (m) HUD(slot, `🎞️ Convertendo ${base}`)
    })
    await new Promise(r => c.on("close", r))

    const parts = decideParts(dur)
    const seg = dur / parts

    for (let i = 0; i < parts; i++) {
        const out = path.join(downloadsPath, `${base} parte ${i+1}.mp4`)
        const start = Math.floor(i * seg)
        const len = i === parts-1 ? Math.ceil(dur-start) : Math.ceil(seg)
        const s = spawn("ffmpeg", ["-y", "-ss", `${start}`, "-t", `${len}`, "-i", final, "-c", "copy", out])
        s.stderr.on("data", d => HUD(slot, `✂️ Parte ${i+1}/${parts} — ${base}`))
        await new Promise(r => s.on("close", r))
    }

    fs.unlinkSync(temp)
    fs.unlinkSync(final)
}

// ===================== EXEC =====================
;(async () => {
    console.log("\n🚀 Iniciando...")

    // === CACHE AUTO-REBUILD ===
    let cache = loadCache()
    let rebuild = false

    if (!cache || Object.values(cache).flat().length === 0) rebuild = true
    else {
        const mp4 = fs.readdirSync(downloadsPath).filter(f => f.endsWith(".mp4"))
        if (mp4.length < Object.values(cache).flat().length) rebuild = true
    }

    if (rebuild) {
        console.log("🔄 Recriando cache...")
        cache = await collectVideos()
        console.log("✅ Cache reconstruído.")
    }

    const videos = Object.values(cache).flat()
    console.log(`📦 Total de vídeos a baixar: ${videos.length}`)
    if (videos.length === 0) return console.log("⚠️ Nada para baixar.")

    const downloadQueue = [...videos]
    const convertQueue = []
    let done = 0

    async function DownloadWorker() {
        while (downloadQueue.length) {
            const v = downloadQueue.shift()
            const res = await downloadVideo(v)
            if (res) convertQueue.push(res)
        }
    }

    async function ConvertWorker(slot) {
        while (downloadQueue.length || convertQueue.length) {
            const job = convertQueue.shift()
            if (!job) { await new Promise(r => setTimeout(r, 500)); continue }
            await convertAndSplit(job, slot)
            done++
        }
    }

    await Promise.all([
        ...Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, DownloadWorker),
        ...Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, (_,i) => ConvertWorker(i))
    ])

    console.log(`\n✅ Finalizado — ${done} vídeos processados.\n`)
})()
