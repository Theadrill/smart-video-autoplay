import express from "express"
import cors from "cors"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

const app = express()
app.use(cors())
app.use(express.static("public"))

// Configurações
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"))
const downloadsPath = path.resolve(config.downloadsPath)
const dbPath = path.resolve("database.json")
const roundStatePath = path.resolve("roundState.json")

// Estado da rodada persistente
let roundState = {
    playedVideos: new Set(),
    playedChannelsThisRound: new Set(),
}

function loadRoundState() {
    try {
        if (fs.existsSync(roundStatePath)) {
            const data = JSON.parse(fs.readFileSync(roundStatePath, "utf8"))
            roundState.playedVideos = new Set(data.playedVideos || [])
            roundState.playedChannelsThisRound = new Set(data.playedChannelsThisRound || [])
            console.log("Estado da rodada carregado.")
        }
    } catch (err) {
        console.error("Erro ao carregar estado da rodada:", err)
    }
}

function saveRoundState() {
    const data = {
        playedVideos: [...roundState.playedVideos],
        playedChannelsThisRound: [...roundState.playedChannelsThisRound],
    }
    try {
        fs.writeFileSync(roundStatePath, JSON.stringify(data, null, 2))
    } catch (err) {
        console.error("Erro ao salvar estado da rodada:", err)
    }
}

// Função para contar vídeos na database
function countDBItems(db) {
    return Object.values(db).reduce((acc, arr) => acc + arr.length, 0)
}

// Sincroniza database com arquivos
function syncDatabase() {
    const files = fs.readdirSync(downloadsPath).filter((f) => f.endsWith(".mp4"))
    let db = {}
    if (fs.existsSync(dbPath)) {
        try {
            db = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
        } catch {
            db = {}
        }
    }
    const dbCount = countDBItems(db)
    const fileCount = files.length

    if (dbCount !== fileCount) {
        console.log("Diferença detectada nos arquivos, rodando generateDatabase.js...")
        execSync("node generateDatabase.js", { stdio: "inherit" })
    } else {
        let needsUpdate = false
        for (const canal of Object.keys(db)) {
            if (
                db[canal].some((entry) => !files.includes(entry.arquivo)) ||
                files.some((f) => {
                    const c = f.split(" - ")[0]?.trim()
                    return c === canal && !db[canal].find((e) => e.arquivo === f)
                })
            ) {
                needsUpdate = true
                break
            }
        }
        if (needsUpdate) {
            console.log("Arquivos incoerentes com database.json, rodando generateDatabase.js...")
            execSync("node generateDatabase.js", { stdio: "inherit" })
        } else {
            console.log("Database já está sincronizada.")
        }
    }
}

syncDatabase()

let database = {}
try {
    database = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
} catch (e) {
    console.error("Erro ao ler database.json:", e)
}

loadRoundState()

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
}

app.get("/api/next", (req, res) => {
    const canais = Object.keys(database)
    if (canais.length === 0) return res.json({ file: null })

    // Quando terminar a rodada (todos os canais já tocados)
    if (roundState.playedChannelsThisRound.size === canais.length) {
        // Log detalhado antes de limpar
        console.log(`Fim da rodada! Total de canais tocados: ${roundState.playedChannelsThisRound.size}`)
        console.log(`Total de vídeos tocados na rodada: ${[...roundState.playedVideos].filter((videoArquivo) => Object.values(database).some((videos) => videos.some((v) => v.arquivo === videoArquivo))).length}`)

        roundState.playedChannelsThisRound.clear()
        console.log("Iniciando nova rodada, canais resetados")
    }

    let canaisDisponiveis = canais.filter((c) => !roundState.playedChannelsThisRound.has(c))
    if (canaisDisponiveis.length === 0) {
        roundState.playedChannelsThisRound.clear()
        canaisDisponiveis = [...canais]
    }

    const canalSorteado = randomChoice(canaisDisponiveis)

    const videosDoCanal = database[canalSorteado]
    let videosDisponiveis = videosDoCanal.filter((v) => !roundState.playedVideos.has(v.arquivo))

    if (videosDisponiveis.length === 0) {
        videosDisponiveis = [...videosDoCanal]
    }

    const videoSorteado = randomChoice(videosDisponiveis)

    // Salva os estados ANTES de modificar para exibir logs corretos
    const canalJaTocado = roundState.playedChannelsThisRound.has(canalSorteado)
    const videoJaTocado = roundState.playedVideos.has(videoSorteado.arquivo)

    roundState.playedChannelsThisRound.add(canalSorteado)
    roundState.playedVideos.add(videoSorteado.arquivo)

    saveRoundState()

    console.log(`Canal sorteado: ${canalSorteado}`)
    console.log(`Canal já foi tocado nesta rodada? ${canalJaTocado ? "Sim" : "Não"}`)
    console.log(`Vídeo sorteado: ${videoSorteado.video}`)
    console.log(`Já foi tocado? ${videoJaTocado ? "Sim" : "Não"}`)

    res.json({ file: videoSorteado.arquivo })
})

app.get("/video/:name", (req, res) => {
    const filePath = path.join(downloadsPath, req.params.name)
    if (!fs.existsSync(filePath)) return res.status(404).send("Arquivo não encontrado")
    res.sendFile(filePath)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Servidor rodando: http://localhost:${PORT}`)
})
