import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { ensureHLSCache } from "./streamGenerator.js";
import { getChannelVideosCached, channelKeyFromUrl } from "./youtubeScraper.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ===================== CONFIG =====================
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

const downloadsPaths = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map((p) => path.resolve(p))
  : [path.resolve(config.downloadsPath)];

const dbPath = path.resolve("database.json");
const roundStatePath = path.resolve("roundState.json");
const blacklistPath = path.resolve("blacklist.json");

// ===================== YT-DLP CONFIG =====================
const cookiesFile = path.resolve("cookies.txt");
const ytdlpCookies = fs.existsSync(cookiesFile)
  ? ` --cookies "${cookiesFile}"`
  : ` --cookies-from-browser chrome`;
const ytdlpBase =
  `yt-dlp --extractor-args "youtube:player_client=android" ` +
  `-f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" ` +
  `--merge-output-format mp4` + ytdlpCookies;

// Prepend local bin to PATH (wrapper para yt-dlp com cookies)
try {
  const binDir = path.resolve("bin");
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
} catch {}

// Tentar manter yt-dlp atualizado (evita falhas de nsig)
try {
  execSync("yt-dlp -U", { stdio: "inherit" });
} catch {}

// Checagem de pastas (ignorar quando local:false)
console.log("\n📂 Pastas onde os vídeos serão buscados:");
downloadsPaths.forEach((p) => console.log("   →", p));

if (config.local === false) {
  console.log("🎬 MODO YOUTUBE ATIVO → Ignorando pastas locais.\n");
} else {
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

  if (pastasExistentes.length === 0) {
    console.log("\n❌ Nenhuma pasta encontrada!");
    console.log("Crie ao menos uma pasta listada no config.json.");
    console.log("Encerrando servidor...\n");
    process.exit(1);
  }

  const activeDownloadsPath =
    pastasComVideos.length > 0 ? pastasComVideos[0] : pastasExistentes[0];

  console.log("\n✅ Pasta selecionada automaticamente:");
  console.log("   🎯 " + activeDownloadsPath + "\n");

  if (pastasComVideos.length === 0) {
    console.log("⚠️ Nenhum vídeo local encontrado ainda.");
    console.log("   → O servidor está rodando e aguardando vídeos serem adicionados.\n");
  }
}

// ===================== ROUND STATE LOCAL =====================
let roundState = { playedVideos: new Set(), playedChannelsThisRound: new Set() };

function loadRoundState() {
  try {
    if (fs.existsSync(roundStatePath)) {
      const data = JSON.parse(fs.readFileSync(roundStatePath, "utf8"));
      roundState.playedVideos = new Set(data.playedVideos || []);
      roundState.playedChannelsThisRound = new Set(data.playedChannelsThisRound || []);
      console.log("✅ Estado da rodada carregado.");
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
    ),
    "utf8"
  );
}

// ===================== BLACKLIST (files + videoIds) =====================
let blacklist = { files: new Set(), videoIds: new Set() };

function loadBlacklist() {
  try {
    if (fs.existsSync(blacklistPath)) {
      const data = JSON.parse(fs.readFileSync(blacklistPath, "utf8"));
      blacklist.files = new Set(data.files || []);
      blacklist.videoIds = new Set(data.videoIds || []);
      console.log("✅ Blacklist carregada.");
      return;
    }
  } catch (err) {
    console.error("⚠️ Erro ao carregar blacklist:", err);
  }
  console.log("⚠️ blacklist.json não existia → criando nova.");
  saveBlacklist();
}

function saveBlacklist() {
  try {
    const data = {
      files: [...blacklist.files],
      videoIds: [...blacklist.videoIds],
    };
    fs.writeFileSync(blacklistPath, JSON.stringify(data, null, 2), "utf8");
    console.log(`📝 blacklist atualizada (${blacklist.files.size} arquivos / ${blacklist.videoIds.size} IDs)`);
  } catch (err) {
    console.error("⚠️ Erro ao salvar blacklist:", err);
  }
}

function extractIdFromFilename(file) {
  try {
    let base = file.replace(/\.mp4$/i, "").replace(/\s+parte\s+\d+$/i, "");
    const parts = base.split(" - ");
    return (parts[parts.length - 1] || "").trim();
  } catch {
    return null;
  }
}

function isBlacklistedFile(file) {
  if (blacklist.files.has(file)) return true;
  const id = extractIdFromFilename(file);
  return id && blacklist.videoIds.has(id);
}

function findFileInDownloads(file) {
  for (const base of downloadsPaths) {
    const full = path.join(base, file);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// ===================== DATABASE LOCAL =====================
let database = {};

function syncDatabase() {
  console.log("🔄 Sincronizando database com arquivos atuais...\n");
  const before = JSON.stringify(Object.keys(database));
  execSync("node generateDatabase.js", { stdio: "inherit" });
  const newDb = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const after = JSON.stringify(Object.keys(newDb));

  if (before !== after) {
    console.log("♻️ Mudança detectada nos canais → Resetando roundState.");
    roundState = { playedVideos: new Set(), playedChannelsThisRound: new Set() };
    saveRoundState();
  }

  return newDb;
}

database = syncDatabase();
loadRoundState();
loadBlacklist();

// ===================== WATCH LOCAL CHANGES =====================
let watchTimeout = null;
function triggerResync() {
  clearTimeout(watchTimeout);
  watchTimeout = setTimeout(() => {
    console.log("\n🔄 Detectado mudança na pasta → Re-sincronizando database...\n");
    database = syncDatabase();
  }, 1200);
}

if (config.local !== false) {
  for (const folder of downloadsPaths) {
    if (!fs.existsSync(folder)) continue;
    console.log("👀 Observando:", folder);
    fs.watch(folder, { persistent: true }, (event, filename) => {
      if (filename && filename.toLowerCase().endsWith(".mp4")) triggerResync();
    });
  }
}

// ===================== WATCH CONFIG (mudar local em tempo real) =====================
let dynamicLocalWatchers = [];

function startLocalWatchersIfNeeded() {
  if (dynamicLocalWatchers.length) return;
  for (const folder of downloadsPaths) {
    if (!fs.existsSync(folder)) continue;
    console.log("?? Observando:", folder);
    const w = fs.watch(folder, { persistent: true }, (event, filename) => {
      if (filename && filename.toLowerCase().endsWith(".mp4")) triggerResync();
    });
    dynamicLocalWatchers.push(w);
  }
}

function stopLocalWatchers() {
  try {
    for (const w of dynamicLocalWatchers) try { w.close(); } catch {}
  } catch {}
  dynamicLocalWatchers = [];
}

try {
  let cfgWatchTimeout = null;
  let lastLocalMode = config.local;
  fs.watch("config.json", { persistent: true }, () => {
    clearTimeout(cfgWatchTimeout);
    cfgWatchTimeout = setTimeout(() => {
      try {
        const fresh = JSON.parse(fs.readFileSync("config.json", "utf8"));
        if (fresh && Object.prototype.hasOwnProperty.call(fresh, "local")) {
          const newLocal = fresh.local;
          if (newLocal !== lastLocalMode) {
            console.log(`\n?? Config alterado: local => ${newLocal === false ? "false (YouTube)" : "true (Local)"}`);
            config.local = newLocal;
            lastLocalMode = newLocal;
            if (newLocal === false) {
              stopLocalWatchers();
            } else {
              startLocalWatchersIfNeeded();
              database = syncDatabase();
            }
          }
        }
      } catch (e) {
        console.log("?? Erro ao recarregar config.json:", e?.message || e);
      }
    }, 300);
  });
} catch {}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===================== YOUTUBE ROUND STATE =====================
const ytRoundStatePath = path.resolve("ytRoundState.json");
let ytRoundState = { playedChannelsThisRound: [], playedVideosByChannel: {} };

function loadYtRoundState() {
  try {
    if (fs.existsSync(ytRoundStatePath)) {
      ytRoundState = JSON.parse(fs.readFileSync(ytRoundStatePath, "utf8"));
      ytRoundState.playedChannelsThisRound ||= [];
      ytRoundState.playedVideosByChannel ||= {};
      console.log("✅ Estado da rodada (YouTube) carregado.");
    } else {
      saveYtRoundState();
    }
  } catch {
    console.log("⚠️ ytRoundState corrompido → recriando limpo");
    saveYtRoundState();
  }
}

function saveYtRoundState() {
  fs.writeFileSync(ytRoundStatePath, JSON.stringify(ytRoundState, null, 2), "utf8");
}
loadYtRoundState();

// ===================== STREAM FOLDER =====================
const streamFolder = path.resolve("stream");
if (!fs.existsSync(streamFolder)) fs.mkdirSync(streamFolder, { recursive: true });
app.use("/stream", express.static(streamFolder));

// ===================== CONCURRENCY AUTO (modo C) =====================
let preloadInFlight = false;
let lastCpuSample = process.cpuUsage();
let lastTime = process.hrtime.bigint();

function getProcessCpuPercent() {
  const now = process.hrtime.bigint();
  const diffNs = Number(now - lastTime);
  const diff = process.cpuUsage(lastCpuSample);
  const usedNs = (diff.user + diff.system) * 1000;
  lastTime = now;
  lastCpuSample = process.cpuUsage();
  const pct = usedNs / diffNs;
  return Math.max(0, Math.min(1, pct));
}

function canPreloadNow() {
  if (preloadInFlight) return false;
  const cpuPct = getProcessCpuPercent();
  if (cpuPct > 0.65) {
    console.log(`⏳ (PRELOAD) CPU alta (${Math.round(cpuPct * 100)}%) → aguardando`);
    return false;
  }
  return true;
}

async function preloadNextVideo(chKey) {
  try {
    if (!canPreloadNow()) return;
    preloadInFlight = true;

    const channelUrl = (config.streamUrls || config.urls || []).find(
      (u) => channelKeyFromUrl(u) === chKey
    );
    if (!channelUrl) return;

    let videos = await getChannelVideosCached(channelUrl);

    // Filtros igual ao modo principal
    if (Array.isArray(config.includeKeywords) && config.includeKeywords.length > 0) {
      videos = videos.filter((v) =>
        config.includeKeywords.some((k) => v.title.toLowerCase().includes(k.toLowerCase()))
      );
    }

    if (Array.isArray(config.excludeKeywords) && config.excludeKeywords.length > 0) {
      videos = videos.filter(
        (v) => !config.excludeKeywords.some((k) => v.title.toLowerCase().includes(k.toLowerCase()))
      );
    }

    if (config.minDurationSeconds) {
      videos = videos.filter((v) => !v.title.toLowerCase().includes("short"));
    }

    videos = videos.filter((v) => !blacklist.videoIds.has(v.id));

    const played = ytRoundState.playedVideosByChannel[chKey] || [];
    let candidates = videos.filter((v) => !played.includes(v.id));

    if (!candidates.length) {
      ytRoundState.playedVideosByChannel[chKey] = [];
      saveYtRoundState();
      candidates = videos;
    }

    const next = candidates.find((v) => v.ageDays <= 30) || candidates[0];
    if (!next) return;

    const mp4Path = path.join(streamFolder, next.id, `${next.id}.mp4`);
    if (!fs.existsSync(mp4Path)) {
      console.log(`⏳ (PRELOAD) Baixando próximo vídeo: ${next.id}`);
      fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
      try {
        execSync(
  `yt-dlp --cookies "cookies.txt" -f "bestvideo+bestaudio" --merge-output-format mp4 -o "${mp4Path}" "https://www.youtube.com/watch?v=${next.id}"`,
  { stdio: "inherit" }
);


      } catch (e) {
        console.log(`⚠️ (PRELOAD) Falha no yt-dlp para ${next.id}:`, e?.message || e);
        return;
      }
    }

    if (fs.existsSync(mp4Path)) {
      ensureHLSCache(mp4Path, streamFolder, next.id);
    } else {
      console.log(`[PRELOAD] MP4 ausente após yt-dlp: ${mp4Path}`);
      return;
    }
    console.log(`✅ (PRELOAD) Próximo vídeo pronto: ${next.id}`);
  } catch (e) {
    console.log("⚠️ Erro no preload:", e?.message || e);
  } finally {
    preloadInFlight = false;
  }
}

// ==========================================================
// ⏭ API - Próximo vídeo (LOCAL ou YOUTUBE)
// ==========================================================
app.get("/api/next", async (req, res) => {
  // ====== MODO LOCAL (mantido exatamente como o seu) ======
  if (config.local !== false) {
    const canais = Object.keys(database);
    if (!canais.length) return res.json({ file: null });

    if (roundState.playedChannelsThisRound.size === canais.length) {
      console.log("\n🔄 Fim da rodada → Resetando canais.");
      roundState.playedChannelsThisRound.clear();
    }

    const canaisDisponiveis = canais.filter((c) => !roundState.playedChannelsThisRound.has(c));
    const canal = randomChoice(canaisDisponiveis);
    const videos = database[canal];

    let naoTocados = videos.filter(
      (v) => !roundState.playedVideos.has(v.arquivo) && !isBlacklistedFile(v.arquivo)
    );
    if (!naoTocados.length) naoTocados = videos.filter((v) => !isBlacklistedFile(v.arquivo));

    const escolhido = randomChoice(naoTocados);

    roundState.playedChannelsThisRound.add(canal);
    roundState.playedVideos.add(escolhido.arquivo);
    saveRoundState();

    console.log(`\n🎬 Canal: ${canal}`);
    console.log(`🎞 Vídeo sorteado: ${escolhido.video}`);
    console.log(`📁 Arquivo: ${escolhido.arquivo}`);

    return res.json({ file: escolhido.arquivo });
  }

  // ====== MODO YOUTUBE (rodada separada + filtros) ======
  const channels = config.streamUrls || config.urls || [];
  if (!channels.length) return res.json({ file: null });

  if (ytRoundState.playedChannelsThisRound.length === channels.length) {
    console.log("\n🔄 [YT] Fim da rodada → Resetando canais (YouTube).");
    ytRoundState.playedChannelsThisRound = [];
    saveYtRoundState();
  }

  const available = channels.filter(
    (url) => url && !ytRoundState.playedChannelsThisRound.includes(channelKeyFromUrl(url))
  );
  const pool = available.length ? available : channels.filter(Boolean);
  if (!pool.length) {
    console.log("[YT] Nenhuma URL de canal válida no config.");
    return res.json({ hls: null, id: null });
  }
  const channelUrl = randomChoice(pool);
  const chKey = channelKeyFromUrl(channelUrl);

  let videos = await getChannelVideosCached(channelUrl);

  if (Array.isArray(config.includeKeywords) && config.includeKeywords.length > 0) {
    videos = videos.filter((v) =>
      config.includeKeywords.some((k) => v.title.toLowerCase().includes(k.toLowerCase()))
    );
  }

  if (Array.isArray(config.excludeKeywords) && config.excludeKeywords.length > 0) {
    videos = videos.filter(
      (v) => !config.excludeKeywords.some((k) => v.title.toLowerCase().includes(k.toLowerCase()))
    );
  }

  if (config.minDurationSeconds) {
    videos = videos.filter((v) => !v.title.toLowerCase().includes("short"));
  }

  videos = videos.filter((v) => !blacklist.videoIds.has(v.id));

  const played = ytRoundState.playedVideosByChannel[chKey] || [];
  let candidates = videos.filter((v) => !played.includes(v.id));

  if (!candidates.length) {
    console.log(`⚠️ [YT] Nenhum vídeo disponível após filtros → Resetando canal ${chKey}`);
    ytRoundState.playedVideosByChannel[chKey] = [];
    saveYtRoundState();
    candidates = videos;
  }

  if (!candidates.length) {
    console.log(`❌ [YT] Nenhum vídeo encontrado no canal: ${chKey}`);
    return res.json({ hls: null, id: null });
  }

  let chosen = candidates.find((v) => v.ageDays <= 30) || candidates[0];

  if (!chosen) {
    console.log("❌ [YT] Erro crítico: lista vazia mesmo após reset. Abortando com segurança.");
    return res.json({ hls: null, id: null });
  }

  ytRoundState.playedChannelsThisRound.push(chKey);
  ytRoundState.playedVideosByChannel[chKey] = [
    ...(ytRoundState.playedVideosByChannel[chKey] || []),
    chosen.id,
  ];
  saveYtRoundState();

  try {
    const mp4Path = path.join(streamFolder, chosen.id, `${chosen.id}.mp4`);
    if (!fs.existsSync(mp4Path)) {
      fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
      console.log(`[YT] ⬇️ Baixando vídeo atual: ${chosen.id}`);
      try {
        execSync(
  `yt-dlp --cookies "cookies.txt" -f "bestvideo+bestaudio" --merge-output-format mp4 -o "${mp4Path}" "https://www.youtube.com/watch?v=${chosen.id}"`,
  { stdio: "inherit" }
);

      } catch (e) {
        console.log(`[YT] yt-dlp falhou para ${chosen.id}:`, e?.message || e);
        return res.json({ hls: null, id: null, error: "yt-dlp failed" });
      }
    }

    if (fs.existsSync(mp4Path)) {
      ensureHLSCache(mp4Path, streamFolder, chosen.id);
    } else {
      console.log(`[YT] MP4 ausente após yt-dlp: ${mp4Path}`);
      return res.json({ hls: null, id: null, error: "download missing" });
    }
  } catch (e) {
    console.log("[YT] Falha no download/conversão:", e?.message || e);
    return res.json({ hls: null, id: null, error: "yt-dlp failed" });
  }

  console.log(`\n[YT] 🎬 Canal: ${chKey}`);
  console.log(`[YT] 🎞 Vídeo: ${chosen.title}  (id=${chosen.id}, age=${chosen.ageDays}d)`);

  preloadNextVideo(chKey);

  return res.json({ hls: `/stream/${chosen.id}/${chosen.id}.m3u8`, id: chosen.id });
});

// ==========================================================
// 🛑 Blacklist (local + YouTube)
// ==========================================================
app.post("/api/blacklist", async (req, res) => {
  const { id, file } = req.body || {};

  if (id) {
    if (!blacklist.videoIds.has(id)) blacklist.videoIds.add(id);
    saveBlacklist();

    const folder = path.join(streamFolder, id);
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });

    return res.json({ ok: true, blacklisted: { id } });
  }

  if (file) {
    const located = findFileInDownloads(file);
    if (!located) return res.status(404).json({ ok: false, error: "arquivo não encontrado" });

    try {
      fs.unlinkSync(located);
      const canonical = path.basename(located);
      blacklist.files.add(canonical);

      const vid = extractIdFromFilename(canonical);
      if (vid) blacklist.videoIds.add(vid);
      saveBlacklist();

      roundState.playedVideos.delete(canonical);
      saveRoundState();

      database = syncDatabase();
      return res.json({ ok: true, blacklisted: { file: canonical, id: vid || null } });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "falha ao deletar arquivo" });
    }
  }

  return res.status(400).json({ ok: false, error: "informe id (YT) ou file (local)" });
});

// ==========================================================
// ⏮ API - Vídeo anterior (LOCAL)
// ==========================================================
app.get("/api/previous", (req, res) => {
  let list = [...roundState.playedVideos];

  if (list.length < 2) {
    console.log("⏳ Não há vídeo anterior.");
    return res.json({ file: null });
  }

  const last = list.pop();
  const previous = list[list.length - 1];

  const getChannel = (f) => f.split(" - ")[0];

  roundState.playedVideos = new Set(list);
  roundState.playedChannelsThisRound.delete(getChannel(last));
  roundState.playedChannelsThisRound.add(getChannel(previous));
  saveRoundState();

  console.log(`⏪ Voltando para: ${previous}`);
  res.json({ file: previous });
});

// ==========================================================
// 🎥 Servir vídeo local direto
// ==========================================================
app.get("/video/:name", (req, res) => {
  const file = req.params.name;
  const located = findFileInDownloads(file);

  if (!located) return res.status(404).send("Arquivo não encontrado");

  if (!req.headers.range) {
    console.log(`▶️ Tocando agora: ${file}`);
    console.log(`   📍 Origem real: ${located}`);
  }

  res.sendFile(located);
});

// ==========================================================
// 🔥 Deletar vídeo (compat)
// ==========================================================
const deleteVideoHandler = (req, res) => {
  try {
    let file = (req.body && req.body.file) || (req.query && req.query.file);
    if (!file) {
      console.log("❌ deleteVideo: file ausente na requisição");
      return res.status(400).json({ ok: false, error: "file ausente" });
    }

    try {
      file = decodeURIComponent(file);
    } catch {}
    file = file.trim();

    const located = findFileInDownloads(file);
    if (!located) {
      console.log(`❌ deleteVideo: arquivo não encontrado: ${file}`);
      return res.status(404).json({ ok: false, file, error: "arquivo não encontrado" });
    }

    fs.unlinkSync(located);
    console.log(`🗑️  DELETADO => ${file}`);

    const canonical = path.basename(located);
    blacklist.files.add(canonical);
    const id = extractIdFromFilename(canonical);
    if (id) blacklist.videoIds.add(id);

    saveBlacklist();
    console.log(`✅ blacklist atualizada`);

    roundState.playedVideos.delete(canonical);
    saveRoundState();

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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Servidor rodando: http://localhost:${PORT}\n`));
app.get("/api/deleteVideo", deleteVideoHandler);
app.post("/api/deleteVideo", deleteVideoHandler);

// ==========================================================
// API - Info by ID (YouTube)
// ==========================================================
app.get("/api/info/:id", async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return res.json({ channel: null, title: null });

    const channels = config.streamUrls || config.urls || [];
    for (const url of channels) {
      try {
        const videos = await getChannelVideosCached(url);
        const hit = videos.find((v) => v.id === id);
        if (hit) {
          return res.json({ channel: channelKeyFromUrl(url), title: hit.title });
        }
      } catch {}
    }
    return res.json({ channel: null, title: null });
  } catch (e) {
    return res.json({ channel: null, title: null });
  }
});
