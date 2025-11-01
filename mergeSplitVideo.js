// mergeVideos.js
// Autor: você 🫶 + GPT
// Objetivo: unir/dividir vídeos por partes com lógica inteligente, retomada segura e barra de progresso limpa.
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

            const label =
                typeof labelFn === "function"
                    ? labelFn(lastTime) // dinâmico
                    : labelFn // string fixa

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
// FFPROBE + GROUP
// -----------------------
function getDurationSeconds(abs) {
    return Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${abs}"`).toString()) || 0
}
function getTotalDuration(parts) {
    return parts.reduce((sum, p) => sum + getDurationSeconds(path.join(originalFolder, p.file)), 0)
}

function groupFiles() {
    const files = fs.readdirSync(originalFolder).filter((f) => f.endsWith(".mp4"))
    const groups = {}
    for (const f of files) {
        const m = f.match(/(.+?)\s+(?:parte|part)\s*([0-9]+)\.mp4$/i)
        if (!m) continue
        const base = m[1].trim(),
            num = Number(m[2])
        if (!groups[base]) groups[base] = []
        groups[base].push({ file: f, partNum: num })
    }
    for (const k in groups) groups[k].sort((a, b) => a.partNum - b.partNum)
    return groups
}
function cleanupVideoOutput(base) {
    for (const f of fs.readdirSync(outputFolder)) if (f.startsWith(base)) fs.unlinkSync(path.join(outputFolder, f))
}

// -----------------------
// MERGE + SPLIT (AGORA COM NOME DA PARTE)
// -----------------------
async function mergePartsToFile(partsFiles, outputPath, totalDurationSec, labelInfo = "") {
    const listFile = path.join(originalFolder, "_list.txt")

    // ✅ Usa aspas simples e ESCAPA apenas apóstrofos no caminho
    fs.writeFileSync(
        listFile,
        partsFiles
            .map((f) => {
                const full = path.join(originalFolder, f)
                // Escapa apóstrofo para o formato do concat demuxer: 'foo'\''bar'
                const escaped = full.replace(/'/g, `'\\''`)
                return `file '${escaped}'`
            })
            .join("\n")
    )

    await runFfmpegWithProgress(["-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outputPath], totalDurationSec, `⏳ MERGE ${labelInfo}`)
    fs.unlinkSync(listFile)
}

async function splitFileToNParts(inputPath, parts, baseName) {
    const total = getDurationSeconds(inputPath)
    const seg = total / parts
    for (let i = 0; i < parts; i++) {
        const out = path.join(outputFolder, `${baseName} - finalPart${i + 1}.mp4`)
        await runFfmpegWithProgress(["-y", "-hide_banner", "-ss", String(i * seg), "-t", String(seg), "-i", inputPath, "-c", "copy", out], seg, `⏳ SPLIT (${i + 1}/${parts})`)
    }
}

// -----------------------
// MAIN
// -----------------------
console.log("====================================")
console.log("🎬 MERGE/SPLIT COM RETOMADA + PROGRESSO")
console.log(`📂 Origem: ${originalFolder}`)
console.log(`📦 Saída:  ${outputFolder}`)
console.log("====================================")

const groups = groupFiles()
let names = Object.keys(groups)

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

    let finalParts
    const durationSec = getTotalDuration(partsList)
    const durationMin = durationSec / 60

    if (defaultFinal === 0) {
        if (durationMin >= minutesMoreThan) {
            finalParts = bigVideoParts
            console.log(`⏱️ GRANDE (${durationMin.toFixed(1)} min) → finalParts = ${finalParts}`)
        } else if (durationMin < minutesLessThan) {
            finalParts = partsIfLess
            console.log(`⏱️ CURTO (${durationMin.toFixed(1)} min) → finalParts = ${finalParts}`)
        } else {
            finalParts = partsIfMore
            console.log(`⏱️ MÉDIO (${durationMin.toFixed(1)} min) → finalParts = ${finalParts}`)
        }
    } else {
        finalParts = defaultFinal
        console.log(`⚙️ finalParts fixo = ${finalParts}`)
    }

    try {
        cleanupVideoOutput(base)

        if (finalParts === currentParts) {
            partsList.forEach((p, i) => fs.copyFileSync(path.join(originalFolder, p.file), path.join(outputFolder, `${base} - finalPart${i + 1}.mp4`)))
        } else if (finalParts === 1) {
            await mergePartsToFile(
                partsList.map((p) => p.file),
                path.join(outputFolder, `${base}.mp4`),
                durationSec,
                "(única parte)"
            )
        } else if (currentParts % finalParts === 0) {
            const g = currentParts / finalParts
            for (let i = 0; i < finalParts; i++) {
                const slice = partsList.slice(i * g, (i + 1) * g).map((p) => p.file)
                const dur = getTotalDuration(partsList.slice(i * g, (i + 1) * g))
                await mergePartsToFile(slice, path.join(outputFolder, `${base} - finalPart${i + 1}.mp4`), dur, `(parte ${i + 1} de ${finalParts})`)
            }
        } else {
            const temp = path.join(outputFolder, `${base} - TEMP_MERGED.mp4`)
            await mergePartsToFile(
                partsList.map((p) => p.file),
                temp,
                durationSec,
                "(merge total)"
            )
            await splitFileToNParts(temp, finalParts, base)
            fs.unlinkSync(temp)
        }

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
