import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import https from "https"
import readline from "readline"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// prettier-ignore
let URLS = []
let INCLUDE_KEYWORDS = []
let EXCLUDE_KEYWORDS = []
let MIN_DURATION = 180
let IGNORE_SHORTS = true

// ==========================================================
// 📖 Leitura de config.json
// ==========================================================
const configPath = path.resolve("config.json")
if (!fs.existsSync(configPath)) {
    console.error("❌ config.json não encontrado!")
    process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
if (Array.isArray(config.urls)) URLS = config.urls
if (Array.isArray(config.includeKeywords)) INCLUDE_KEYWORDS = config.includeKeywords
if (Array.isArray(config.excludeKeywords)) EXCLUDE_KEYWORDS = config.excludeKeywords
if (config.minDurationSeconds) MIN_DURATION = config.minDurationSeconds
if (typeof config.ignoreShorts === "boolean") IGNORE_SHORTS = config.ignoreShorts

const downloadsPath = path.resolve(config.downloadsPath)
if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true })

const CACHE_FILE = path.join(downloadsPath, "videos_cache.json")

// ==========================================================
// 🧹 Organização e limpeza de logs
// ==========================================================
const logsDir = path.resolve("logs")
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })

const ERROR_LOG = path.join(logsDir, "error.log")
const DOWNLOAD_LOG = path.join(logsDir, "download.log")
const CONVERSION_LOG = path.join(logsDir, "conversion.log")

for (const logFile of [ERROR_LOG, DOWNLOAD_LOG, CONVERSION_LOG]) {
    try {
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile)
        fs.writeFileSync(logFile, "")
    } catch (err) {
        console.warn(`⚠️ Não foi possível limpar o log: ${logFile}`, err.message)
    }
}
console.log("🧹 Logs antigos limpos e pasta 'logs' organizada.\n")

// ==========================================================
// ⚙️ Configurações
// ==========================================================
const MAX_CONCURRENT_DOWNLOADS = config.maxConcurrentDownloads || 3
const MAX_CONCURRENT_CONVERSIONS = config.maxConcurrentConversions || 2

// ==========================================================
// 🧠 Funções auxiliares
// ==========================================================
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
    console.log(`💾 Cache salvo em: ${CACHE_FILE}\n`)
}

function loadCache() {
    if (!fs.existsSync(CACHE_FILE)) return null
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
    } catch {
        return null
    }
}

function logTo(file, text) {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`)
}

// ==========================================================
// 🌐 Captura nome do canal via HTML
// ==========================================================
async function getChannelName(url) {
    return new Promise((resolve) => {
        let normalizedUrl = url.replace("/@", "/")
        if (!normalizedUrl.endsWith("/")) normalizedUrl += "/"

        console.log("🌐 Capturando nome do canal diretamente do HTML...")
        console.log(`🌐 Tentando obter HTML de: ${normalizedUrl}`)

        https
            .get(normalizedUrl, { timeout: 10000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(getChannelName(res.headers.location))

                let data = ""
                res.on("data", (chunk) => (data += chunk))
                res.on("end", () => {
                    const match = data.match(/<title>(.*?)<\/title>/i)
                    if (match && match[1]) {
                        const title = match[1].replace("- YouTube", "").trim()
                        console.log(`📺 Canal detectado: ${title}`)
                        return resolve(title)
                    }
                    console.log("⚠️ Não foi possível capturar o nome do canal pelo HTML.")
                    resolve(null)
                })
            })
            .on("error", (err) => {
                console.log(`⚠️ Erro ao capturar HTML: ${err.message}`)
                resolve(null)
            })
    })
}

// ==========================================================
// 🎬 Coleta e filtro
// ==========================================================
async function collectFilteredVideos() {
    const cache = {}

    for (const url of URLS) {
        const type = url.includes("/playlist?list=") ? "playlist" : url.includes("/watch?v=") ? "video" : "channel"

        console.log(`\n============================================================`)
        console.log(`🔍 Coletando vídeos de: ${url}`)
        console.log(`📺 Tipo detectado: ${type}`)
        console.log(`============================================================\n`)

        let channelName = "Canal desconhecido"
        if (type === "channel") {
            try {
                const name = await getChannelName(url)
                if (name) {
                    channelName = sanitizeFilename(name)
                    console.log(`🧠 Nome do canal confirmado: ${channelName}`)
                }
            } catch (err) {
                console.warn("⚠️ Erro ao capturar nome do canal:", err.message)
            }
        }

        const tmpFile = path.join(downloadsPath, "tmp_list.json")
        try {
            execSync(`yt-dlp -j --flat-playlist "${url}" > "${tmpFile}"`, { stdio: "inherit" })
        } catch {
            console.error(`⚠️ Falha ao coletar vídeos de ${url}`)
            continue
        }

        const lines = fs.readFileSync(tmpFile, "utf8").split("\n").filter(Boolean)
        fs.unlinkSync(tmpFile)
        const entries = lines.map((line) => JSON.parse(line))

        const inc = INCLUDE_KEYWORDS.map((k) => k.toLowerCase())
        const exc = EXCLUDE_KEYWORDS.map((k) => k.toLowerCase())

        const filtered = entries.filter((v) => {
            const t = v.title?.toLowerCase() || ""
            const includeOK = inc.length === 0 || inc.some((kw) => t.includes(kw))
            const excludeOK = exc.length === 0 || !exc.some((kw) => t.includes(kw))
            const isShort = IGNORE_SHORTS && (t.includes("#shorts") || t.includes("shorts") || (v.duration && v.duration < 60))
            return includeOK && excludeOK && !isShort
        })

        console.log(`🎬 ${entries.length} vídeos totais.`)
        console.log(INCLUDE_KEYWORDS.length > 0 || EXCLUDE_KEYWORDS.length > 0 ? `🔎 ${filtered.length} correspondem ao filtro de inclusão/exclusão.\n` : "📥 Nenhum filtro definido — todos os vídeos serão baixados.\n")

        cache[url] = filtered.map((v) => ({
            id: v.id,
            title: v.title,
            uploader: channelName || v.uploader || "Canal desconhecido",
        }))
    }

    saveCache(cache)
    return cache
}

// ==========================================================
// 🧩 Revalidação do cache existente
// ==========================================================
function revalidateCache(cache) {
    const newCache = {}
    let totalOriginal = 0
    let totalNovo = 0

    const inc = INCLUDE_KEYWORDS.map((k) => k.toLowerCase())
    const exc = EXCLUDE_KEYWORDS.map((k) => k.toLowerCase())

    for (const [url, videos] of Object.entries(cache)) {
        totalOriginal += videos.length
        newCache[url] = videos.filter((v) => {
            const t = v.title?.toLowerCase() || ""
            const includeOK = inc.length === 0 || inc.some((kw) => t.includes(kw))
            const excludeOK = exc.length === 0 || !exc.some((kw) => t.includes(kw))
            const isShort = IGNORE_SHORTS && (t.includes("#shorts") || t.includes("shorts"))
            return includeOK && excludeOK && !isShort
        })
        totalNovo += newCache[url].length
    }

    const removidos = totalOriginal - totalNovo
    console.log(`🧹 Revalidação do cache: ${totalOriginal} → ${totalNovo} vídeos (removidos ${removidos}).\n`)
    saveCache(newCache)
    return newCache
}

// ==========================================================
// ⚙️ Download + conversão com progresso
// ==========================================================
async function getDuration(filePath) {
    return new Promise((resolve) => {
        const ffprobe = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath])
        let output = ""
        ffprobe.stdout.on("data", (d) => (output += d.toString()))
        ffprobe.on("close", () => resolve(parseFloat(output.trim()) || 0))
    })
}

async function downloadVideo(video) {
    const videoId = video.id
    const title = sanitizeFilename(video.title || "Sem título")
    const channel = sanitizeFilename(video.uploader || "Canal desconhecido")
    const baseName = `${channel} - ${title} - ${videoId}`
    const tempFile = path.join(downloadsPath, `${baseName}.orig.mp4`)

    console.log(`⬇️  Iniciando download: ${title}`)
    logTo(DOWNLOAD_LOG, `Baixando: ${title}`)

    return new Promise((resolve) => {
        const proc = spawn("yt-dlp", [`https://www.youtube.com/watch?v=${videoId}`, "-f", "b[ext=mp4]", "-o", tempFile, "--newline", "--no-overwrites"])

        proc.stdout.on("data", (data) => {
            const line = data.toString().trim()
            if (line.startsWith("[download]")) {
                readline.clearLine(process.stdout, 0)
                readline.cursorTo(process.stdout, 0)
                process.stdout.write(`📥 ${title} — ${line.replace("[download]", "").trim()}`)
            }
        })

        proc.on("close", async (code) => {
            readline.clearLine(process.stdout, 0)
            readline.cursorTo(process.stdout, 0)

            if (code !== 0) {
                console.log(`❌ Erro ao baixar: ${title}`)
                logTo(ERROR_LOG, `Erro ao baixar ${title}`)
                return resolve(null)
            }

            const duration = await getDuration(tempFile)
            if (duration < MIN_DURATION) {
                console.log(`⏩ Ignorando ${title} (apenas ${Math.round(duration)}s)`)
                fs.unlinkSync(tempFile)
                return resolve(null)
            }

            console.log(`✅ Download concluído: ${title}`)
            logTo(DOWNLOAD_LOG, `✅ Concluído: ${title}`)
            resolve({ tempFile, baseName })
        })
    })
}

async function convertVideo({ tempFile, baseName }) {
    return new Promise((resolve) => {
        const finalFile = path.join(downloadsPath, `${baseName}.mp4`)
        const partPattern = path.join(downloadsPath, `${baseName}_part_%03d.mp4`)

        console.log(`🎞️  Convertendo: ${baseName}`)

        const ffmpeg = spawn("ffmpeg", ["-y", "-i", tempFile, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-vf", "scale='min(1280,iw)':-2", "-movflags", "+faststart", finalFile])

        ffmpeg.stderr.on("data", (data) => {
            const msg = data.toString()
            const match = msg.match(/time=(\d+:\d+:\d+)/)
            if (match) {
                readline.clearLine(process.stdout, 0)
                readline.cursorTo(process.stdout, 0)
                process.stdout.write(`⚙️  Convertendo ${baseName} — tempo ${match[1]}`)
            }
        })

        ffmpeg.on("close", (code) => {
            readline.clearLine(process.stdout, 0)
            readline.cursorTo(process.stdout, 0)
            if (code !== 0) {
                console.log(`❌ Erro ao converter ${baseName}`)
                logTo(ERROR_LOG, `Erro ao converter ${baseName}`)
                return resolve(false)
            }

            console.log(`🧩 Dividindo vídeo: ${baseName}`)
            const splitter = spawn("ffmpeg", ["-y", "-i", finalFile, "-c", "copy", "-f", "segment", "-segment_time", "300", "-reset_timestamps", "1", partPattern])

            splitter.on("close", () => {
                fs.unlinkSync(tempFile)
                fs.unlinkSync(finalFile)
                console.log(`✅ Finalizado e dividido: ${baseName}`)
                logTo(CONVERSION_LOG, `✅ Convertido e dividido: ${baseName}`)
                resolve(true)
            })
        })
    })
}

// ==========================================================
// 🚀 Execução principal
// ==========================================================
;(async () => {
    console.log("🚀 Iniciando script de coleta e download...\n")

    let cache = loadCache()
    if (!cache) {
        console.log("🧠 Nenhum cache encontrado — gerando novo cache...\n")
        cache = await collectFilteredVideos()
    } else {
        console.log("⚡ Cache existente detectado — revalidando filtros...\n")
        cache = revalidateCache(cache)
    }

    const allVideos = Object.values(cache).flat()
    console.log(`📦 Total de vídeos a baixar: ${allVideos.length}\n`)

    const downloadQueue = [...allVideos]
    const conversionQueue = []
    let concluidos = 0

    async function downloadWorker() {
        while (downloadQueue.length > 0) {
            const video = downloadQueue.shift()
            const result = await downloadVideo(video)
            if (result) conversionQueue.push(result)
        }
    }

    async function conversionWorker() {
        while (true) {
            const task = conversionQueue.shift()
            if (!task) {
                await new Promise((r) => setTimeout(r, 1000))
                if (downloadQueue.length === 0 && conversionQueue.length === 0) break
                continue
            }
            const ok = await convertVideo(task)
            if (ok) concluidos++
        }
    }

    const downloaders = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, downloadWorker)
    const converters = Array.from({ length: MAX_CONCURRENT_CONVERSIONS }, conversionWorker)

    await Promise.all([...downloaders, ...converters])

    console.log("\n============================================================")
    console.log(`📊 Total de vídeos processados: ${allVideos.length}`)
    console.log(`✅ Concluídos com sucesso: ${concluidos}`)
    console.log("🎉 Execução finalizada!")
    console.log("============================================================\n")
})()
