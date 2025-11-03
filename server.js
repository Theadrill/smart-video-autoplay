import express from "express"
import cors from "cors"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
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
// 🎯 Detecta pastas existentes e separa as que possuem vídeos
// ==========================================================
let pastasExistentes = [];
let pastasComVideos = [];

for (const p of downloadsPaths) {
    if (!fs.existsSync(p)) {
        console.log(`⚠️ Pasta NÃO existe: ${p}`);
        continue;
    }

    pastasExistentes.push(p);

    const arquivos = fs.readdirSync(p);
    const hasMP4 = arquivos.some((f) => f.toLowerCase().endsWith(".mp4"));

    if (hasMP4) pastasComVideos.push(p);
    else console.log(`⚠️ Pasta existe mas não contém vídeos .mp4: ${p}`);
}

// Se nenhuma pasta existir → erro real
if (pastasExistentes.length === 0) {
    console.log("\n❌ Nenhuma pasta encontrada!");
    console.log("Crie ao menos uma pasta listada no config.json.");
    console.log("Encerrando servidor...\n");
    process.exit(1);
}

// Se existir pasta mas nenhuma tem vídeo → escolher a primeira existente
let activeDownloadsPath = pastasComVideos.length > 0 ? pastasComVideos[0] : pastasExistentes[0];

console.log("\n✅ Pasta selecionada automaticamente:");
console.log("   🎯 " + activeDownloadsPath + "\n");

// Caso esteja vazia → avisar mas continuar
if (pastasComVideos.length === 0) {
    console.log("⚠️ Nenhum vídeo encontrado ainda.");
    console.log("   → O servidor está rodando e aguardando vídeos serem adicionados.\n");
}


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

// ==========================================================
// 👀 Auto-Atualização da Database quando arquivos mudarem
// ==========================================================
let watchTimeout = null

function triggerResync() {
    clearTimeout(watchTimeout)
    watchTimeout = setTimeout(() => {
        console.log("\n🔄 Detectado mudança na pasta → Re-sincronizando database...\n")
        database = syncDatabase()
    }, 1200) // evita rodar 20x seguidas durante cópia
}

for (const folder of downloadsPaths) {
    if (!fs.existsSync(folder)) continue
    console.log("👀 Observando:", folder)

    fs.watch(folder, { persistent: true }, (event, filename) => {
        if (filename && filename.toLowerCase().endsWith(".mp4")) {
            triggerResync()
        }
    })
}


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

// ==========================================================
// 🔥 API - Deletar vídeo (blacklist)
// ==========================================================
const deleteVideoHandler = (req, res) => {
  try {
    let file = (req.body && req.body.file) || (req.query && req.query.file)
    if (!file) return res.status(400).json({ ok: false, error: "file ausente" })
    try { file = decodeURIComponent(file) } catch {}    if (typeof file === "string") file = file.trim()
    const located = findFileInDownloads(file)
    if (!located) {
      console.log(`⚠️ deleteVideo: arquivo não encontrado: ${file}`)
      return res.status(404).json({ ok: false, error: "arquivo não encontrado" })
    }
    fs.unlinkSync(located)
    console.log(`🗑️ deleteVideo: deletado ${file}`)
    roundState.playedVideos.delete(file)
    saveRoundState()
    database = syncDatabase()
    return res.json({ ok: true })
  } catch (e) {
    console.error("Erro ao deletar vídeo:", e?.message || e)
    return res.status(500).json({ ok: false, error: "erro interno" })
  }
}
app.post("/api/deleteVideo", deleteVideoHandler);
app.get("/api/deleteVideo", deleteVideoHandler);

