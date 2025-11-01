import express from "express"
import cors from "cors"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

const app = express()
app.use(cors())
app.use(express.static("public"))

// Carrega config
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"))

// Agora downloadsPath é ARRAY
const downloadsPaths = Array.isArray(config.downloadsPath) ? config.downloadsPath.map((p) => path.resolve(p)) : [path.resolve(config.downloadsPath)]

const dbPath = path.resolve("database.json")
const roundStatePath = path.resolve("roundState.json")

console.log("\n📂 Pastas onde os vídeos serão buscados:")
downloadsPaths.forEach((p) => console.log("   →", p))

// ==========================================================
// 🎯 Detecta pasta ativa (a primeira que contém vídeos reais)
// ==========================================================
let activeDownloadsPath = null
for (const p of downloadsPaths) {
    if (fs.existsSync(p)) {
        const hasMP4 = fs.readdirSync(p).some((f) => f.toLowerCase().endsWith(".mp4"))
        if (hasMP4) {
            activeDownloadsPath = p
            break
        }
    }
}

// Se nenhuma tinha vídeo → usa a primeira mesmo
if (!activeDownloadsPath) activeDownloadsPath = downloadsPaths[0]

console.log("\n✅ Pasta selecionada automaticamente:")
console.log("   🎯 " + activeDownloadsPath + "\n")

// ==========================================================
// Estado da rodada
// ==========================================================
let roundState = { playedVideos: new Set(), playedChannelsThisRound: new Set() }

function loadRoundState() {
    try {
        if (fs.existsSync(roundStatePath)) {
            const data = JSON.parse(fs.readFileSync(roundStatePath, "utf8"))
            roundState.playedVideos = new Set(data.playedVideos || [])
            roundState.playedChannelsThisRound = new Set(data.playedChannelsThisRound || [])
            console.log("🔁 Estado da rodada carregado.")
        }
    } catch {}
}

function saveRoundState() {
    fs.writeFileSync(
        roundStatePath,
        JSON.stringify(
            {
                playedVideos: [...roundState.playedVideos],
                playedChannelsThisRound: [...roundState.playedChannelsThisRound],
            },
            null,
            2
        )
    )
}

// ==========================================================
// 🔍 Localiza arquivo real físico entre múltiplas pastas
// ==========================================================
function findFileInDownloads(file) {
    for (const base of downloadsPaths) {
        const full = path.join(base, file)
        if (fs.existsSync(full)) return full
    }
    return null
}

// ==========================================================
// 🧱 Reconstrução da database sempre que necessário
// ==========================================================
let database = {} // define ANTES para evitar ReferenceError

function syncDatabase() {
    const before = JSON.stringify(Object.keys(database))
    execSync("node generateDatabase.js", { stdio: "inherit" })
    const newDb = JSON.parse(fs.readFileSync(dbPath, "utf8"))
    const after = JSON.stringify(Object.keys(newDb))

    if (before !== after) {
        console.log("♻️ Mudança detectada nos canais → Resetando roundState.")
        roundState = { playedVideos: new Set(), playedChannelsThisRound: new Set() }
        saveRoundState()
    }

    return newDb
}

console.log("🔄 Sincronizando database com arquivos atuais...\n")
database = syncDatabase()
loadRoundState()

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
}

// ==========================================================
// ⏭ API - Próximo vídeo
// ==========================================================
app.get("/api/next", (req, res) => {
    const canais = Object.keys(database)
    if (canais.length === 0) return res.json({ file: null })

    if (roundState.playedChannelsThisRound.size === canais.length) {
        console.log("\n🔄 Fim da rodada → Resetando canais.")
        roundState.playedChannelsThisRound.clear()
    }

    const canaisDisponiveis = canais.filter((c) => !roundState.playedChannelsThisRound.has(c))
    const canal = randomChoice(canaisDisponiveis)
    const videos = database[canal]

    let naoTocados = videos.filter((v) => !roundState.playedVideos.has(v.arquivo))
    if (naoTocados.length === 0) naoTocados = [...videos]

    const escolhido = randomChoice(naoTocados)

    roundState.playedChannelsThisRound.add(canal)
    roundState.playedVideos.add(escolhido.arquivo)
    saveRoundState()

    console.log(`\n🎬 Canal: ${canal}`)
    console.log(`🎞 Vídeo sorteado: ${escolhido.video}`)
    console.log(`📁 Arquivo: ${escolhido.arquivo}`)

    return res.json({ file: escolhido.arquivo })
})

// ==========================================================
// ⏪ API - Voltar vídeo (reverte rodada corretamente)
// ==========================================================
app.get("/api/previous", (req, res) => {
    let list = [...roundState.playedVideos]

    if (list.length < 2) {
        console.log("⛔ Não há vídeo anterior.")
        return res.json({ file: null })
    }

    const last = list.pop()
    const previous = list[list.length - 1]

    const getChannel = (f) => f.split(" - ")[0]

    // Ajusta roundState corretamente
    roundState.playedVideos = new Set(list)
    roundState.playedChannelsThisRound.delete(getChannel(last))
    roundState.playedChannelsThisRound.add(getChannel(previous))
    saveRoundState()

    console.log(`⏪ Voltando para: ${previous}`)

    return res.json({ file: previous })
})

// ==========================================================
// 🎥 Servir vídeo físico
// ==========================================================
app.get("/video/:name", (req, res) => {
    const file = req.params.name
    const located = findFileInDownloads(file)

    if (!located) {
        if (!req.headers.range) {
            console.log(`❌ Arquivo não encontrado: ${file}`)
        }
        return res.status(404).send("Arquivo não encontrado")
    }

    // Log somente quando iniciar reprodução
    if (!req.headers.range) {
        console.log(`▶️ Tocando agora: ${file}`)
        console.log(`   📍 Origem real: ${located}`)
    }

    res.sendFile(located)
})

// ==========================================================
// 🚀 Servidor
// ==========================================================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`\n✅ Servidor rodando: http://localhost:${PORT}\n`))
