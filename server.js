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
const downloadsPaths = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map(p => path.resolve(p))
  : [path.resolve(config.downloadsPath)]

const dbPath = path.resolve("database.json")
const roundStatePath = path.resolve("roundState.json")

console.log("\n📂 Pastas onde os vídeos serão buscados:")
downloadsPaths.forEach(p => console.log("   →", p))

// Estado da rodada
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
    JSON.stringify({
      playedVideos: [...roundState.playedVideos],
      playedChannelsThisRound: [...roundState.playedChannelsThisRound]
    }, null, 2)
  )
}

// == NOVO: Localiza arquivo real e loga de qual pasta veio ==
function findFileInDownloads(file) {
  for (const base of downloadsPaths) {
    const full = path.join(base, file)
    if (fs.existsSync(full)) {
      return full
    }
  }
  return null
}

// Reconstrói database conforme múltiplas pastas
function syncDatabase() {
  execSync("node generateDatabase.js", { stdio: "inherit" })
  return JSON.parse(fs.readFileSync(dbPath, "utf-8"))
}

let database = syncDatabase()
loadRoundState()

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// == API para escolher próximo vídeo ==
app.get("/api/next", (req, res) => {
  const canais = Object.keys(database)
  if (canais.length === 0) return res.json({ file: null })

  // Se todos os canais já tocaram → reinicia rodada
  if (roundState.playedChannelsThisRound.size === canais.length) {
    console.log("\n🔄 Fim da rodada → Resetando canais.")
    roundState.playedChannelsThisRound.clear()
  }

  const canaisDisponiveis = canais.filter(c => !roundState.playedChannelsThisRound.has(c))
  const canal = randomChoice(canaisDisponiveis)
  const videos = database[canal]

  let naoTocados = videos.filter(v => !roundState.playedVideos.has(v.arquivo))
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

// == SERVE O VÍDEO ==
app.get("/video/:name", (req, res) => {
  const file = req.params.name
  const located = findFileInDownloads(file)

  if (!located) {
    if (!req.headers.range) {
      console.log(`❌ Arquivo não encontrado: ${file}`)
    }
    return res.status(404).send("Arquivo não encontrado")
  }

  // Loga apenas 1x quando o vídeo realmente começa, ignorando streaming parcial
  if (!req.headers.range) {
    console.log(`▶️ Tocando agora: ${file}`)
    console.log(`   📍 Origem real: ${located}`)
  }

  res.sendFile(located)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`\n✅ Servidor rodando: http://localhost:${PORT}\n`))
