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
const downloadsPaths = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map((p) => path.resolve(p))
  : [path.resolve(config.downloadsPath)]

const dbPath = path.resolve("database.json")
const roundStatePath = path.resolve("roundState.json")
const blacklistPath = path.resolve("blacklist.json")

console.log("\n📂 Pastas onde os vídeos serão buscados:")
downloadsPaths.forEach((p) => console.log("   →", p))

// ==========================================================
// 🎯 Detecta pastas existentes e separa as que possuem vídeos
// ==========================================================
let pastasExistentes = []
let pastasComVideos = []

for (const p of downloadsPaths) {
  if (!fs.existsSync(p)) {
    console.log(`⚠️ Pasta NÃO existe: ${p}`)
    continue
  }

  pastasExistentes.push(p)

  const arquivos = fs.readdirSync(p)
  const hasMP4 = arquivos.some((f) => f.toLowerCase().endsWith(".mp4"))

  if (hasMP4) pastasComVideos.push(p)
  else console.log(`⚠️ Pasta existe mas não contém vídeos .mp4: ${p}`)
}

if (pastasExistentes.length === 0) {
  console.log("\n❌ Nenhuma pasta encontrada!")
  console.log("Crie ao menos uma pasta listada no config.json.")
  console.log("Encerrando servidor...\n")
  process.exit(1)
}

let activeDownloadsPath = pastasComVideos.length > 0 ? pastasComVideos[0] : pastasExistentes[0]

console.log("\n✅ Pasta selecionada automaticamente:")
console.log("   🎯 " + activeDownloadsPath + "\n")

if (pastasComVideos.length === 0) {
  console.log("⚠️ Nenhum vídeo encontrado ainda.")
  console.log("   → O servidor está rodando e aguardando vídeos serem adicionados.\n")
}

// ===================== ROUND STATE LOCAL =====================
let roundState = { playedVideos: new Set(), playedChannelsThisRound: new Set() };

function loadRoundState() {
  try {
    if (fs.existsSync(roundStatePath)) {
      const data = JSON.parse(fs.readFileSync(roundStatePath, "utf8"))
      roundState.playedVideos = new Set(data.playedVideos || [])
      roundState.playedChannelsThisRound = new Set(data.playedChannelsThisRound || [])
      console.log("✅ Estado da rodada carregado.")
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
// Blacklist (arquivos e IDs)
// ==========================================================
let blacklist = { files: new Set(), videoIds: new Set() }

function loadBlacklist() {
  try {
    if (fs.existsSync(blacklistPath)) {
      const data = JSON.parse(fs.readFileSync(blacklistPath, "utf8"))
      blacklist.files = new Set(data.files || [])
      blacklist.videoIds = new Set(data.videoIds || [])
      console.log("✅ Blacklist carregada.")
      return
    }
  } catch (err) {
    console.error("⚠️ Erro ao carregar blacklist:", err)
  }

  // Se chegou aqui → criar nova blacklist
  console.log("⚠️ blacklist.json não existia → criando nova.")
  saveBlacklist()
}

function saveBlacklist() {
  try {
    const data = {
      files: [...blacklist.files],
      videoIds: [...blacklist.videoIds]
    }

    fs.writeFileSync(blacklistPath, JSON.stringify(data, null, 2), "utf8")

    console.log(`📝 blacklist atualizada (${data.files.length} arquivos / ${data.videoIds.length} IDs)`)
  } catch (err) {
    console.error("⚠️ Erro ao salvar blacklist:", err)
  }
}

function extractIdFromFilename(file) {
  try {
    let base = file.replace(/\.mp4$/i, "").replace(/\s+parte\s+\d+$/i, "")
    const parts = base.split(" - ")
    return (parts[parts.length - 1] || "").trim()
  } catch {
    return null
  }
}

function isBlacklistedFile(file) {
  if (blacklist.files.has(file)) return true
  const id = extractIdFromFilename(file)
  return id && blacklist.videoIds.has(id)
}

function findFileInDownloads(file) {
  for (const base of downloadsPaths) {
    const full = path.join(base, file)
    if (fs.existsSync(full)) return full
  }
  return null
}

// ==========================================================
// 🧱 Reconstrução da database
// ==========================================================
let database = {}

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
loadBlacklist()

let watchTimeout = null
function triggerResync() {
  clearTimeout(watchTimeout)
  watchTimeout = setTimeout(() => {
    console.log("\n🔄 Detectado mudança na pasta → Re-sincronizando database...\n")
    database = syncDatabase()
  }, 1200)
}

for (const folder of downloadsPaths) {
  if (!fs.existsSync(folder)) continue
  console.log("👀 Observando:", folder)

  fs.watch(folder, { persistent: true }, (event, filename) => {
    if (filename && filename.toLowerCase().endsWith(".mp4")) triggerResync()
  })
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ==========================================================
// ⏭ API - Próximo vídeo (LOCAL ou YOUTUBE)
// ==========================================================
app.get("/api/next", (req, res) => {
  const canais = Object.keys(database)
  if (!canais.length) return res.json({ file: null })

  if (roundState.playedChannelsThisRound.size === canais.length) {
    console.log("\n🔄 Fim da rodada → Resetando canais.")
    roundState.playedChannelsThisRound.clear()
  }

  const canaisDisponiveis = canais.filter((c) => !roundState.playedChannelsThisRound.has(c))
  const canal = randomChoice(canaisDisponiveis)
  const videos = database[canal]

  let naoTocados = videos.filter((v) => !roundState.playedVideos.has(v.arquivo) && !isBlacklistedFile(v.arquivo))
  if (!naoTocados.length) naoTocados = videos.filter((v) => !isBlacklistedFile(v.arquivo))

  const escolhido = randomChoice(naoTocados)

  roundState.playedChannelsThisRound.add(canal)
  roundState.playedVideos.add(escolhido.arquivo)
  saveRoundState()

  console.log(`\n🎬 Canal: ${canal}`)
  console.log(`🎞 Vídeo sorteado: ${escolhido.video}`)
  console.log(`📁 Arquivo: ${escolhido.arquivo}`)

  res.json({ file: escolhido.arquivo })
})

// ==========================================================
// ⏪ API - Vídeo anterior
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

  roundState.playedVideos = new Set(list)
  roundState.playedChannelsThisRound.delete(getChannel(last))
  roundState.playedChannelsThisRound.add(getChannel(previous))
  saveRoundState()

  console.log(`⏪ Voltando para: ${previous}`)
  res.json({ file: previous })
})

// ==========================================================
// 🎥 Servir vídeo
// ==========================================================
app.get("/video/:name", (req, res) => {
  const file = req.params.name
  const located = findFileInDownloads(file)

  if (!located) return res.status(404).send("Arquivo não encontrado")

  if (!req.headers.range) {
    console.log(`▶️ Tocando agora: ${file}`)
    console.log(`   📍 Origem real: ${located}`)
  }

  res.sendFile(located)
})

// ==========================================================
// 🔥 Deletar vídeo (Blacklist + remove do disco)
// ==========================================================
app.post("/api/delete", (req, res) => {
  let file = req.body.file || req.query.file
  if (!file) return res.status(400).json({ ok: false, error: "file ausente" })

  try { file = decodeURIComponent(file) } catch {}
  file = file.trim()

  const located = findFileInDownloads(file)
  if (!located) return res.status(404).json({ ok: false, file, error: "arquivo não encontrado" })

  try {
    fs.unlinkSync(located)

    const canonical = path.basename(located)
    blacklist.files.add(canonical)
    const id = extractIdFromFilename(canonical)
    if (id) blacklist.videoIds.add(id)
    saveBlacklist()

    roundState.playedVideos.delete(canonical)
    saveRoundState()

    database = syncDatabase()
    return res.json({ ok: true, file: canonical })
  } catch (e) {
    return res.status(500).json({ ok: false, error: "falha ao deletar arquivo" })
  }
})

const deleteVideoHandler = (req, res) => {
  try {
    let file = (req.body && req.body.file) || (req.query && req.query.file);
    if (!file) {
      console.log("❌ deleteVideo: file ausente na requisição");
      return res.status(400).json({ ok: false, error: "file ausente" });
    }

    try { file = decodeURIComponent(file) } catch {}
    file = file.trim();

    const located = findFileInDownloads(file);
    if (!located) {
      console.log(`❌ deleteVideo: arquivo não encontrado: ${file}`);
      return res.status(404).json({ ok: false, file, error: "arquivo não encontrado" });
    }

    // Apaga o arquivo
    fs.unlinkSync(located);
    console.log(`🗑️  DELETADO => ${file}`);

    // Adiciona à blacklist
    const canonical = path.basename(located);
    blacklist.files.add(canonical);

    const id = extractIdFromFilename(canonical);
    if (id) blacklist.videoIds.add(id);

    saveBlacklist();
    console.log(`✅ blacklist atualizada`);

    // Remove do estado da rodada
    roundState.playedVideos.delete(canonical);
    saveRoundState();

    // Re-sincroniza DB
    database = syncDatabase();

    return res.json({ ok: true, file: canonical });

  } catch (e) {
    console.error("⚠️ Erro ao deletar vídeo:", e?.message || e);
    return res.status(500).json({ ok: false, error: "erro interno" });
  }
};


// ==========================================================
// 🚀 Servidor
// ==========================================================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`\n✅ Servidor rodando: http://localhost:${PORT}\n`))
app.get("/api/deleteVideo", deleteVideoHandler)
app.post("/api/deleteVideo", deleteVideoHandler)
