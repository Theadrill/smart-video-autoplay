import fs from "fs"
import path from "path"
import readline from "readline"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load config
const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
const DOWNLOADS = path.resolve(cfg.downloadsPath)
const SELECTED = path.resolve(cfg.selectedPath)
const TARGET_GB = Number(cfg.targetGB) || 40
const TARGET_BYTES = TARGET_GB * 1024 * 1024 * 1024
const RANDOMIZE = cfg.generateRandomNames === true
const MAX_PER_ROUND = Number(cfg.maxVideosPerChannelPerRound) || 0

const MANIFEST_PATH = path.join(SELECTED, "selected_manifest.json")

// Helpers
function humanBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"]
    if (bytes === 0) return "0 B"
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return (bytes / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 2) + " " + units[i]
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
}

function ask(q) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(q, (ans) => {
            rl.close()
            resolve(ans.trim().toLowerCase())
        })
    })
}

function stripPrefix(name) {
    return name.replace(/^\d{4}\s*-\s*/, "").trim()
}

function parseFileName(originalName) {
    const base = originalName.replace(/\.mp4$/i, "")
    const parts = base.split(" - ")
    const canal = parts[0].trim()
    const resto = parts.slice(1).join(" - ").trim()
    const m = resto.match(/parte\s+(\d+)/i)
    let parte = 1
    let titulo = resto
    if (m) {
        parte = parseInt(m[1], 10)
        titulo = resto.replace(m[0], "").trim()
    }
    return { canal, file: `${canal} - ${titulo}${m ? ` parte ${parte}` : ""}.mp4`, parte, titulo }
}

function loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) return null
    try {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).videos || null
    } catch {
        return null
    }
}

function saveManifest(manifest) {
    const total = manifest.reduce((acc, v) => acc + (v.size || 0), 0)
    fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify(
            {
                targetGB: TARGET_GB,
                finalGB: (total / 1024 ** 3).toFixed(2),
                count: manifest.length,
                videos: manifest,
            },
            null,
            2
        )
    )
}

// ============ 🔀 REORDER & RENAME ============
async function reorderAndRename(manifest) {
    console.log("🔀 Reordenando vídeos (sem repetir canal, ordem randômica de canais por rodada)...")

    const byChannel = {}
    manifest.forEach((v) => {
        if (!byChannel[v.canal]) byChannel[v.canal] = []
        byChannel[v.canal].push(v)
    })
    Object.keys(byChannel).forEach((c) => shuffle(byChannel[c]))

    const final = []
    while (true) {
        const active = Object.keys(byChannel).filter((c) => byChannel[c].length > 0)
        if (!active.length) break
        shuffle(active)
        active.forEach((c) => final.push(byChannel[c].shift()))
    }

    let i = 1
    for (const v of final) {
        const prefix = String(i).padStart(4, "0")
        const newName = `${prefix} - ${v.file}`
        const oldPath = path.join(SELECTED, v.finalName || v.file)
        const newPath = path.join(SELECTED, newName)
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath)
        v.finalName = newName
        i++
    }

    manifest.length = 0
    final.forEach((v) => manifest.push(v))
}

// ============ 🗑️ REDUÇÃO ============
async function reduceToTarget(manifest) {
    console.log("\n⚠️ Tamanho excedeu o limite. Iniciando redução equilibrada por canal.\n")

    let total = manifest.reduce((acc, v) => acc + v.size, 0)

    while (total > TARGET_BYTES) {
        const byChannel = {}
        manifest.forEach((v) => {
            if (!byChannel[v.canal]) byChannel[v.canal] = []
            byChannel[v.canal].push(v)
        })

        const canais = Object.keys(byChannel)
        shuffle(canais)

        let removed = false

        for (const canal of canais) {
            const list = byChannel[canal]
            if (!list.length) continue

            const item = list.pop()
            const filePath = path.join(SELECTED, item.finalName || item.file)

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Removido: ${item.finalName || item.file} (${humanBytes(item.size)})`)
            }

            const idx = manifest.findIndex((v) => v.finalName === item.finalName || v.file === item.file)
            if (idx !== -1) manifest.splice(idx, 1)

            total = manifest.reduce((a, v) => a + v.size, 0)
            console.log(`📉 Total agora: ${humanBytes(total)} / ${humanBytes(TARGET_BYTES)}`)

            removed = true
            if (total <= TARGET_BYTES) break
        }

        if (!removed) break
    }

    console.log("\n♻️ Reordenando após redução...")
    await reorderAndRename(manifest)
    saveManifest(manifest)
}

// ============ 🚀 EXECUÇÃO PRINCIPAL ============
;(async () => {
    console.log("\n==============================================")
    console.log("🚀 Smart Video Selection - v3 (Verbose Mode ON)")
    console.log("==============================================\n")

    if (!fs.existsSync(SELECTED)) fs.mkdirSync(SELECTED, { recursive: true })

    let manifest = loadManifest()
    let hadManifest = !!manifest

    if (!manifest) {
        console.log("📄 Manifest não encontrado → reconstruindo...")
        manifest = []
        const mp4s = fs.readdirSync(SELECTED).filter((f) => f.toLowerCase().endsWith(".mp4"))
        for (const f of mp4s) {
            const original = stripPrefix(f)
            const info = parseFileName(original)
            const size = fs.statSync(path.join(SELECTED, f)).size
            manifest.push({ ...info, size, finalName: f })
        }
        saveManifest(manifest)
        console.log("✅ Manifest reconstruído.\n")
    }

    // Refresh sizes + detect manual changes
    const beforeCount = manifest.length
    const beforeFiles = manifest.map((v) => v.finalName || v.file)

    const filesNow = fs.readdirSync(SELECTED).filter((f) => f.toLowerCase().endsWith(".mp4"))

    if (beforeFiles.length !== filesNow.length || beforeFiles.some((f) => !filesNow.includes(f))) {
        console.log("⚠️ Alterações manuais detectadas → ajustando manifest + reorder automático...")
        manifest = []
        for (const f of filesNow) {
            const original = stripPrefix(f)
            const info = parseFileName(original)
            const size = fs.statSync(path.join(SELECTED, f)).size
            manifest.push({ ...info, size, finalName: f })
        }
        await reorderAndRename(manifest)
        saveManifest(manifest)
    }

    let currentTotal = manifest.reduce((acc, v) => acc + v.size, 0)
    console.log(`📊 Tamanho atual: ${humanBytes(currentTotal)} / ${humanBytes(TARGET_BYTES)}\n`)

    // If above limit → reduce
    if (currentTotal > TARGET_BYTES) {
        await reduceToTarget(manifest)
        console.log("✅ Redução concluída.\n")
        process.exit(0)
    }

    // If under limit → copy more
    console.log("📥 Procurando vídeos novos para copiar...\n")

    const allDownloads = fs.readdirSync(DOWNLOADS).filter((f) => f.toLowerCase().endsWith(".mp4"))
    const grouped = {}

    allDownloads.forEach((f) => {
        const info = parseFileName(f)
        if (!manifest.some((m) => m.file === info.file)) {
            if (!grouped[info.canal]) grouped[info.canal] = {}
            if (!grouped[info.canal][info.parte]) grouped[info.canal][info.parte] = []
            grouped[info.canal][info.parte].push(info)
        }
    })

    for (const c of Object.keys(grouped)) for (const p of Object.keys(grouped[c])) shuffle(grouped[c][p])

    let parteAtual = 1
    let copied = false

    while (currentTotal < TARGET_BYTES) {
        console.log(`🔄 Rodada por parte: ${parteAtual}`)
        let moved = false

        for (const canal of Object.keys(grouped)) {
            const list = grouped[canal][parteAtual]
            if (!list || !list.length) continue

            const take = MAX_PER_ROUND === 0 ? list.length : Math.min(MAX_PER_ROUND, list.length)
            const pick = list.splice(0, take)

            for (const info of pick) {
                if (currentTotal >= TARGET_BYTES) break
                const src = path.join(DOWNLOADS, info.file)
                if (!fs.existsSync(src)) continue

                const size = fs.statSync(src).size
                const dest = path.join(SELECTED, info.file)
                console.log(`   📥 Copiando: ${info.file} (${humanBytes(size)})`)
                fs.copyFileSync(src, dest)

                manifest.push({ ...info, size, finalName: info.file })
                currentTotal += size
                copied = true
                moved = true

                console.log(`   📊 Acumulado: ${humanBytes(currentTotal)} / ${humanBytes(TARGET_BYTES)}\n`)
            }
        }

        if (!moved) {
            parteAtual++
            if (!Object.keys(grouped).some((c) => grouped[c][parteAtual]?.length)) break
        }
    }

    saveManifest(manifest)

    if (RANDOMIZE) {
        console.log("🔁 Reordenando lista final...")
        await reorderAndRename(manifest)
        saveManifest(manifest)
    }

    console.log("\n✅ Finalizado!")
    console.log(`📦 Total no destino: ${humanBytes(currentTotal)}\n`)
    process.exit(0)
})()
