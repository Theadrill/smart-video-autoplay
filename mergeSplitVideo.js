// mergeVideos.js
// Autor: você 🫶 + GPT, versão "unir videos pt2"
// Objetivo: unir/dividir vídeos em partes com lógica inteligente, retomada segura e barra de progresso limpa.
// Mantido: TODOS OS LOGS, SPINNER, VISUAL E COMENTÁRIOS ORIGINAIS.
// Requisitos: ffmpeg e ffprobe no PATH.

import fs from "fs"
import path from "path"
import { spawn, execSync } from "child_process"

// -----------------------
// CONFIG
// -----------------------
const config = JSON.parse(fs.readFileSync("config.json", "utf8"))
const originalFolder = path.resolve(config.originalFolderForMergeSplit)
const defaultFinal = Number(config.defaultFinalVideoParts ?? 0)
const minutesLessThan = Number(config.minutesLessThan ?? 15)
const partsIfLess = Number(config.partsIfLess ?? 1)
const partsIfMore = Number(config.partsIfMore ?? 3)
const minutesMoreThan = Number(config.minutesMoreThan ?? 60)
const bigVideoParts = Number(config.bigVideoParts ?? 6)

if (!fs.existsSync(originalFolder)) {
    console.error(`❌ Pasta original não existe: ${originalFolder}`)
    process.exit(1)
}

// Pasta de saída
const outputFolder = path.join(originalFolder, "merge-split")
if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true })

// DB de retomada
const progressFile = path.join(outputFolder, "merge-split-progress.json")
let progress = { lastVideo: null, status: "completed" }
try {
    if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, "utf8"))
} catch {}

// Salva DB
function saveProgress() {
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2))
}

// -----------------------
// HELPERS: LOG / TEMPO
// -----------------------
function fmtTime(sec) {
    sec = Math.max(0, sec)
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const pad = (n) => String(n).padStart(2, "0")
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// -----------------------
// PROGRESSO COM BARRA
// -----------------------
function runFfmpegWithProgress(args, totalSeconds, labelFn) {
    return new Promise((resolve, reject) => {
        const spinnerFrames = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"]
        let spinIndex = 0
        let lastTime = 0
        const startWall = Date.now()
        let fullErrorOutput = ""

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })

        proc.stderr.on("data", (chunk) => {
            const s = chunk.toString()
            fullErrorOutput += s

            const match = s.match(/time=(\d{2}):(\d{2}):(\d{2})/)
            if (!match) return

            const hh = +match[1],
                mm = +match[2],
                ss = +match[3]
            lastTime = hh * 3600 + mm * 60 + ss

            const frac = totalSeconds > 0 ? Math.min(1, lastTime / totalSeconds) : 0
            const elapsedWall = (Date.now() - startWall) / 1000
            const rate = lastTime > 0 ? lastTime / elapsedWall : 1
            const remaining = (totalSeconds - lastTime) / Math.max(rate, 0.01)

            const filled = Math.round(frac * 20)
            const bar = `[${"■".repeat(filled)}${"□".repeat(20 - filled)}]`
            const pct = Math.round(frac * 100)
            const spin = spinnerFrames[spinIndex++ % spinnerFrames.length]

            const label = typeof labelFn === "function" ? labelFn(lastTime) : labelFn

            process.stdout.write("\r" + `${spin} ${label} ${bar} ${pct}%  (${fmtTime(lastTime)} / ${fmtTime(totalSeconds)})  ⏱️ ETA: ${fmtTime(remaining)}  ⚡ ${rate.toFixed(2)}x` + "\x1b[K")
        })

        proc.on("close", (code) => {
            // limpa linha
            process.stdout.write("\r\x1b[K")

            const finalLabel = typeof labelFn === "function" ? labelFn(totalSeconds) : labelFn
            const finalTime = fmtTime(totalSeconds)

            if (code === 0) {
                console.log(`✅ Concluído — ${finalLabel} — duração ${finalTime}`)
                resolve()
            } else {
                console.log(`❌ Falhou — ${finalLabel}\n`)
                console.log("------ FFmpeg Output ------\n")
                console.log(fullErrorOutput.trim())
                console.log("\n---------------------------\n")
                reject(new Error("FFmpeg falhou"))
            }
        })
    })
}

// -----------------------
// FFPROBE
// -----------------------
function getDurationSeconds(abs) {
    return Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${abs}"`).toString()) || 0
}

// -----------------------
// AGRUPAMENTO (CORRIGIDO PARA "parte N" SEM HÍFEN)
// -----------------------
function groupFiles() {
    const files = fs.readdirSync(originalFolder).filter((f) => f.endsWith(".mp4"))
    const groups = {}

    for (const f of files) {
        const m = f.match(/(.+?)\s+parte\s+([0-9]+)\.mp4$/i)
        if (!m) continue
        const base = m[1].trim()
        const num = Number(m[2])
        if (!groups[base]) groups[base] = []
        groups[base].push({ file: f, partNum: num })
    }

    for (const k in groups) groups[k].sort((a, b) => a.partNum - b.partNum)
    return groups
}

// -----------------------
// CHECAR SE JÁ ESTÁ CONCLUÍDO
// -----------------------
function alreadyProcessed(base, finalParts) {
    const existing = fs.readdirSync(outputFolder).filter((f) => f.startsWith(base + " parte ") && f.endsWith(".mp4"))
    return existing.length === finalParts
}

// -----------------------
// LIMPAR OUTPUT DE UM VÍDEO
// -----------------------
function cleanupVideoOutput(base) {
    for (const f of fs.readdirSync(outputFolder)) {
        if (f.startsWith(base + " parte ")) fs.unlinkSync(path.join(outputFolder, f))
    }
}

// -----------------------
// MERGE + SPLIT
// -----------------------
async function mergeAll(partsList, base) {
    const listFile = path.join(originalFolder, "_list.txt")
    fs.writeFileSync(listFile, partsList.map((p) => `file '${path.join(originalFolder, p.file).replace(/'/g, `'\\''`)}'`).join("\n"))

    const total = partsList.reduce((sum, p) => sum + getDurationSeconds(path.join(originalFolder, p.file)), 0)

    const temp = path.join(outputFolder, `${base} - TEMP_MERGED.mp4`)

    await runFfmpegWithProgress(["-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", temp], total, `⏳ MERGE (total)`)

    fs.unlinkSync(listFile)
    return temp
}

async function splitFile(inputPath, parts, base) {
    const total = getDurationSeconds(inputPath)
    const seg = total / parts

    for (let i = 0; i < parts; i++) {
        const out = path.join(outputFolder, `${base} parte ${i + 1}.mp4`)
        await runFfmpegWithProgress(["-y", "-hide_banner", "-ss", String(i * seg), "-t", String(seg), "-i", inputPath, "-c", "copy", out], seg, `⏳ SPLIT (${i + 1}/${parts})`)
    }
}

// -----------------------
// MAIN
// -----------------------
console.log("====================================")
console.log("🎬 MERGE/SPLIT COM RETOMADA + PROGRESSO (unir videos pt2)")
console.log(`📂 Origem: ${originalFolder}`)
console.log(`📦 Saída:  ${outputFolder}`)
console.log("====================================")

const groups = groupFiles()
let names = Object.keys(groups)

// Retomada
if (progress.lastVideo && progress.status !== "completed") {
    names = [progress.lastVideo, ...names.filter((n) => n !== progress.lastVideo)]
}

for (let index = 0; index < names.length; index++) {
    const base = names[index]
    const partsList = groups[base]
    const currentParts = partsList.length

    const totalVideos = names.length
    const videoNumber = index + 1

    console.log(`\n🎞️ Vídeo (${videoNumber} de ${totalVideos}): ${base}`)
    console.log(`📌 Partes detectadas: ${currentParts}`)

    if (progress.lastVideo === base && progress.status !== "completed") {
        console.log("⚠️ Retomando → limpando partes incompletas...")
        cleanupVideoOutput(base)
    }

    progress.lastVideo = base
    progress.status = "incomplete"
    saveProgress()

    // determina finalParts
    const totalDuration = partsList.reduce((sum, p) => sum + getDurationSeconds(path.join(originalFolder, p.file)), 0)
    const durationMin = totalDuration / 60

    let finalParts
    if (defaultFinal === 0) {
        if (durationMin >= minutesMoreThan) finalParts = bigVideoParts
        else if (durationMin < minutesLessThan) finalParts = partsIfLess
        else finalParts = partsIfMore
    } else {
        finalParts = defaultFinal
    }

    console.log(`🎯 finalParts = ${finalParts}`)

    // ✅ PULAR SE JÁ EXISTE
    if (alreadyProcessed(base, finalParts)) {
        console.log("✅ Já pronto anteriormente → pulando.")
        progress.status = "completed"
        saveProgress()
        continue
    }

    try {
        cleanupVideoOutput(base)

        const temp = await mergeAll(partsList, base)
        await splitFile(temp, finalParts, base)
        fs.unlinkSync(temp)

        progress.status = "completed"
        saveProgress()
        console.log("✅ Vídeo concluído.")
    } catch (err) {
        console.error(`❌ Erro em "${base}":`, err.message)
        console.error("Ao reiniciar, retomará automaticamente este vídeo.")
        process.exit(1)
    }
}

console.log("\n✅ Processo concluído.")
