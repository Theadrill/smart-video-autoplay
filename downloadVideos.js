// ==========================================================
// downloadVideos.js — Rodrigo FINAL 2025 (concorrente)
// - Client: web_embedded_player (sem PO token, sem solver)
// - Usa motor de título/canal similar ao renomearVideos.js
// - Respeita config.maxConcurrentDownloads e maxConcurrentConversions
// - Enquanto converte/splita, continua baixando até N simultâneos
// ==========================================================

import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import fetch from "node-fetch"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT = __dirname
const LOG_FILE = path.join(ROOT, "log.txt")
const COOKIES = path.join(ROOT, "cookies.txt")

// ==========================================================
// LOG
// ==========================================================
function log(msg) {
    const ts = new Date().toISOString()
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`, "utf8")
}

// ==========================================================
// CONFIG
// ==========================================================
if (!fs.existsSync("config.json")) {
    console.error("❌ config.json não encontrado!")
    process.exit(1)
}

const config = JSON.parse(fs.readFileSync("config.json", "utf8"))

const MAX_CONCURRENT_DOWNLOADS = config.maxConcurrentDownloads || 2
const MAX_CONCURRENT_CONVERSIONS = config.maxConcurrentConversions || 1

function resolveDownloadsPath(raw) {
    if (Array.isArray(raw)) {
        for (const p of raw) {
            if (fs.existsSync(path.resolve(p))) return path.resolve(p)
        }
        return path.resolve("./downloads")
    }
    const abs = path.resolve(raw)
    return fs.existsSync(abs) ? abs : path.resolve("./downloads")
}

const downloadsPath = resolveDownloadsPath(config.downloadsPath)

// ==========================================================
// FUNÇÕES DE TÍTULO/CANAL (baseadas no renomearVideos.js)
// ==========================================================
const UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "Mozilla/5.0 (X11; Linux x86_64)",
]

function randomUA() {
    return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]
}

function limparNome(str) {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\\/:*?\"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

// 1) Via noembed
async function tentarViaNoEmbed(id) {
    try {
        const url = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`
        const json = await fetch(url).then((r) => r.json())
        if (json?.title && json?.author_name) {
            return {
                titulo: limparNome(json.title),
                canal: limparNome(json.author_name),
            }
        }
    } catch (e) {
        log("noembed falhou: " + e)
    }
    return null
}

// 2) Via yt-dlp dump-json
function tentarViaYtDlp(id) {
    try {
        const cmd = `yt-dlp -J --cookies "${COOKIES}" "https://www.youtube.com/watch?v=${id}"`
        const out = execSync(cmd, { encoding: "utf8" })
        const json = JSON.parse(out)
        if (json?.title && json?.uploader) {
            return {
                titulo: limparNome(json.title),
                canal: limparNome(json.uploader),
            }
        }
    } catch (e) {
        log("yt-dlp JSON falhou: " + e)
    }
    return null
}

// 3) Via HTML raspado
async function tentarViaHTML(id) {
    try {
        const html = await fetch(`https://www.youtube.com/watch?v=${id}`, {
            headers: {
                "User-Agent": randomUA(),
                // aqui apenas passamos o cookie bruto como fallback
                Cookie: fs.existsSync(COOKIES)
                    ? fs.readFileSync(COOKIES, "utf8")
                    : "",
            },
        }).then((r) => r.text())

        const titulo =
            html.match(/"title":"(.*?)"/)?.[1] ??
            html.match(/<title>(.*?)<\/title>/)?.[1]

        const canal =
            html.match(/"ownerChannelName":"(.*?)"/)?.[1] ??
            html.match(/"channelName":"(.*?)"/)?.[1]

        if (titulo && canal) {
            return {
                titulo: limparNome(titulo),
                canal: limparNome(canal),
            }
        }
    } catch (e) {
        log("HTML falhou: " + e)
    }
    return null
}

// Função principal para obter título + canal
async function obterInfoVideo(id) {
    // 1) noembed
    const a = await tentarViaNoEmbed(id)
    if (a) return a

    // 2) yt-dlp JSON
    const b = tentarViaYtDlp(id)
    if (b) return b

    // 3) HTML
    const c = await tentarViaHTML(id)
    if (c) return c

    // fallback
    return { titulo: "Vídeo", canal: "Canal" }
}

// ==========================================================
// ffprobe
// ==========================================================
function ffprobeInfo(file) {
    return new Promise((resolve) => {
        const p = spawn("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            file,
        ])

        let out = ""
        p.stdout.on("data", (d) => (out += d.toString()))
        p.on("close", () => {
            try {
                const j = JSON.parse(out)
                const s = j.streams?.[0] || {}
                resolve({
                    codec: s.codec_name || "unknown",
                    width: s.width || 0,
                    height: s.height || 0,
                    duration: Number(j.format?.duration || 0),
                })
            } catch {
                resolve({ codec: "unknown", width: 0, height: 0, duration: 0 })
            }
        })
    })
}

// ==========================================================
// DOWNLOAD (client web_embedded_player)
// ==========================================================
function download(id, outFile, exact720 = false) {
    return new Promise((resolve) => {
        const format = exact720
            ? "bestvideo[ext=mp4][height=720]/bestvideo[ext=mp4][height<=720]"
            : "bestvideo[ext=mp4][height<=720]"

        const args = [
            `https://www.youtube.com/watch?v=${id}`,
            "-f",
            format,
            "-o",
            outFile,
            "--no-part",
            "--no-overwrites",
            "--cookies",
            COOKIES,
            "--extractor-args",
            "youtube:player_client=web_embedded_player",
        ]

        let out = "",
            err = ""

        const p = spawn("yt-dlp", args)

        p.stdout.on("data", (d) => (out += d.toString()))
        p.stderr.on("data", (d) => (err += d.toString()))

        p.on("close", (code) => {
            const ok = code === 0 && fs.existsSync(outFile)

            if (!ok) {
                log("--------------------------------------------------")
                log(`YT-DLP FAIL → ${id}`)
                log(out)
                log(err)
            }

            resolve(ok)
        })
    })
}

// ==========================================================
// CONVERSÃO
// ==========================================================
function convert(inFile, outFile, height) {
    return new Promise((resolve) => {
        const scale = height > 720 ? "scale=1280:-2" : "scale='min(1280,iw)':-2"

        const p = spawn("ffmpeg", [
            "-y",
            "-i",
            inFile,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "30",
            "-vf",
            scale,
            "-movflags",
            "+faststart",
            outFile,
        ])

        p.stderr.on("data", (d) => {
            const t = d.toString().match(/time=\d{2}:\d{2}:\d{2}/)
            if (t) process.stdout.write(` ⏱ ${t[0]}\r`)
        })

        p.on("close", () => {
            process.stdout.write("\n")
            resolve()
        })
    })
}

// ==========================================================
// SPLIT
// ==========================================================
async function splitVideo(file, base, duration) {
    const m = duration / 60
    let parts

    if (config.defaultFinalVideoParts > 0) parts = config.defaultFinalVideoParts
    else if (m < config.minutesLessThan) parts = config.partsIfLess
    else if (m > config.minutesMoreThan) parts = config.bigVideoParts
    else parts = config.partsIfMore

    const seg = duration / parts

    for (let i = 0; i < parts; i++) {
        const start = Math.floor(i * seg)
        const dur =
            i === parts - 1 ? Math.ceil(duration - start) : Math.ceil(seg)

        const out = path.join(downloadsPath, `${base} parte ${i + 1}.mp4`)

        await new Promise((res) => {
            const p = spawn("ffmpeg", [
                "-y",
                "-ss",
                start.toString(),
                "-t",
                dur.toString(),
                "-i",
                file,
                "-c",
                "copy",
                out,
            ])
            p.on("close", res)
        })
    }
}

// ==========================================================
// FILAS DE DOWNLOAD E CONVERSÃO
// ==========================================================
let activeDownloads = 0
let activeConversions = 0

const downloadQueue = [] // { video, index, total, ... }
const conversionQueue = [] // mesmos objetos, já com temp/final/base/título/canal

let allDoneResolve
const allDonePromise = new Promise((res) => {
    allDoneResolve = res
})
let finished = false

function checkAllDone() {
    if (
        !finished &&
        downloadQueue.length === 0 &&
        conversionQueue.length === 0 &&
        activeDownloads === 0 &&
        activeConversions === 0
    ) {
        finished = true
        allDoneResolve()
    }
}

// Worker de DOWNLOAD
function startNextDownload() {
    while (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
        const job = downloadQueue.shift()
        if (!job) break

        activeDownloads++

        ;(async () => {
            try {
                await handleDownloadJob(job)
            } catch (e) {
                log("Erro em handleDownloadJob: " + e)
            } finally {
                activeDownloads--
                startNextDownload() // tenta pegar mais da fila
                checkAllDone()
            }
        })()
    }
}

// Worker de CONVERSÃO/SPLIT
function startNextConversion() {
    while (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
        const job = conversionQueue.shift()
        if (!job) break

        activeConversions++

        ;(async () => {
            try {
                await handleConversionAndSplitJob(job)
            } catch (e) {
                log("Erro em handleConversionAndSplitJob: " + e)
            } finally {
                activeConversions--
                startNextConversion() // pega próximo da fila
                checkAllDone()
            }
        })()
    }
}

// ==========================================================
// LÓGICA DO DOWNLOAD (por job)
// ==========================================================
async function handleDownloadJob(job) {
    const { video, index, total } = job
    const id = video.id

    // carrega título/canal se ainda não
    if (!job.infoLoaded) {
        const info = await obterInfoVideo(id)
        job.titulo = info.titulo
        job.canal = info.canal
        job.base = `${job.canal} - ${job.titulo} - ${id}`
        job.tempFile = path.join(downloadsPath, `${job.base}.orig.mp4`)
        job.finalFile = path.join(downloadsPath, `${job.base}.mp4`)
        job.infoLoaded = true
    }

    console.log(`vídeo ${index} de ${total} — Baixando: ${job.titulo}`)

    const ok = await download(id, job.tempFile, false)
    if (!ok) {
        console.log("❌ Falha no download, pulando.")
        return
    }

    // coloca na fila de conversão
    conversionQueue.push(job)
    startNextConversion()
}

// ==========================================================
// LÓGICA DE CONVERSÃO + SPLIT (por job)
// ==========================================================
async function handleConversionAndSplitJob(job) {
    const { video, titulo, base, tempFile, finalFile } = job
    const id = video.id

    // ffprobe inicial
    let info = await ffprobeInfo(tempFile)

    // se abaixo de 720p, tenta uma tentativa forçada de 720p
    if (info.height < 720 && info.height > 0) {
        console.log(
            `🔍 ${titulo} está abaixo de 720p — tentando versão 720p...`
        )
        const temp720 = tempFile.replace(".orig.mp4", ".720.mp4")
        const ok720 = await download(id, temp720, true)
        if (ok720 && fs.existsSync(temp720)) {
            fs.unlinkSync(tempFile)
            fs.renameSync(temp720, tempFile)
            info = await ffprobeInfo(tempFile)
        } else {
            log(
                `Não foi possível obter 720p para ${id}, usando resolução atual.`
            )
        }
    }

    // decide se precisa converter
    let precisa = false
    if (info.codec !== "h264") precisa = true
    if (info.height > 720) precisa = true

    if (precisa) {
        console.log(`🎞 Convertendo para h264/720p: ${titulo}`)
        await convert(tempFile, finalFile, info.height)
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
    } else {
        fs.renameSync(tempFile, finalFile)
    }

    const finfo = await ffprobeInfo(finalFile)

    console.log(`✂️ Split: ${base}`)
    await splitVideo(finalFile, base, finfo.duration)

    if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile)
}

// ==========================================================
// EXECUÇÃO PRINCIPAL
// ==========================================================
;(async () => {
    const cacheFile = path.join(downloadsPath, "videos_cache.json")
    if (!fs.existsSync(cacheFile)) {
        console.error("❌ videos_cache.json não encontrado!")
        return
    }

    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    const allVideos = Object.values(cache).flat()

    console.log(`📦 Total de vídeos: ${allVideos.length}\n`)

    // lista de arquivos existentes para não reprocessar
    const existingFiles = fs.existsSync(downloadsPath)
        ? fs.readdirSync(downloadsPath)
        : []

    // ==========================================================
    // 🔍 PRIMEIRO: varrer a pasta e determinar quais vídeos faltam
    // ==========================================================

    const missingList = []

    let index = 0
    for (const video of allVideos) {
        index++
        const id = video.id

        const hasParts = existingFiles.some(
            (f) => f.includes(id) && f.includes("parte")
        )

        if (hasParts) {
            const displayTitle = video.title || id
            console.log(
                `vídeo ${index} de ${allVideos.length} — Já existe (partes): ${displayTitle}`
            )
            continue
        }

        // =========================
        // 🔎 FILTROS DO CONFIG
        // =========================

        const duration = video.duration || 0

        if (config.ignoreShorts && duration < 60) continue

        if (config.minDurationSeconds && duration < config.minDurationSeconds)
            continue

        if (
            Array.isArray(config.includeKeywords) &&
            config.includeKeywords.length > 0
        ) {
            const found = config.includeKeywords.some((k) =>
                (video.title || "").toLowerCase().includes(k.toLowerCase())
            )
            if (!found) continue
        }

        if (
            Array.isArray(config.excludeKeywords) &&
            config.excludeKeywords.length > 0
        ) {
            const bad = config.excludeKeywords.some((k) =>
                (video.title || "").toLowerCase().includes(k.toLowerCase())
            )
            if (bad) continue
        }

        // Se passou por todos os filtros e ainda não existe → adiciona à lista final
        missingList.push(video)
    }

    // ==========================================================
    // 📦 AGORA temos a lista FINAL de vídeos faltando
    // ==========================================================

    console.log(`\n📦 Total faltando baixar: ${missingList.length}\n`)

    let counter = 0
    for (const video of missingList) {
        counter++

        downloadQueue.push({
            video,
            index: counter, // agora correto
            total: missingList.length, // total real
            infoLoaded: false,
            titulo: null,
            canal: null,
            base: null,
            tempFile: null,
            finalFile: null,
        })
    }

    // inicia os workers
    startNextDownload()
    startNextConversion() // só vai rodar quando houver itens na fila

    await allDonePromise

    console.log("\n🚀 FINALIZADO")
})()
