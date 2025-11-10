import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { ensureHLSCache } from "./streamGenerator.js";
import { getChannelVideosCached, channelKeyFromUrl } from "./youtubeScraper.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ===================== LOG FILE (log.txt renovado a cada início) =====================
try {
  const logFile = path.resolve("log.txt");
  try { fs.writeFileSync(logFile, "", "utf8"); } catch {}
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const ts = () => new Date().toISOString();
  const mkLine = (level, args) => {
    const msg = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    return `[${ts()}] [${level}] ${msg}\n`;
  };
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = (...args) => { try { logStream.write(mkLine("LOG", args)); } catch {} orig.log(...args); };
  console.error = (...args) => { try { logStream.write(mkLine("ERROR", args)); } catch {} orig.error(...args); };
  console.warn = (...args) => { try { logStream.write(mkLine("WARN", args)); } catch {} orig.warn(...args); };
  console.info = (...args) => { try { logStream.write(mkLine("INFO", args)); } catch {} orig.info(...args); };
  process.on("uncaughtException", (e) => { try { logStream.write(mkLine("UNCAUGHT", [e?.stack || e])); } catch {} orig.error(e); });
  process.on("unhandledRejection", (e) => { try { logStream.write(mkLine("UNHANDLED", [e?.stack || e])); } catch {} orig.error(e); });
  process.on("exit", () => { try { logStream.end(); } catch {} });
} catch {}

// ===================== CONFIG =====================
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

const downloadsPaths = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map((p) => path.resolve(p))
  : [path.resolve(config.downloadsPath)];

const dbPath = path.resolve("database.json");
const roundStatePath = path.resolve("roundState.json");
const blacklistPath = path.resolve("blacklist.json");
const configPath = path.resolve("config.json");

// ===================== YT-DLP CONFIG =====================
const cookiesFile = path.resolve("cookies.txt");
const ytdlpCookies = fs.existsSync(cookiesFile)
  ? ` --cookies "${cookiesFile}"`
  : ` --cookies-from-browser chrome`;
// Base yt-dlp (não usado diretamente nas execuções abaixo, mantido para referência)
// Preferimos MP4 progressivo. Em casos com EJS, tentamos client android sem cookies.
const ytdlpBase = `yt-dlp -f "b[ext=mp4]"` + ytdlpCookies;

function tryDownloadMp4ById(id, outPath) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const attempts = [
    // 1) Forçar client android e sem cookies para evitar EJS + avisos de cookies
    `yt-dlp --no-cookies --extractor-args "youtube:player_client=android" -f "b[ext=mp4]" -o "${outPath}" "${url}"`,
    // 2) Tentar simples progressivo mp4 como no downloadVideos.js
    `yt-dlp -f "b[ext=mp4]" -o "${outPath}" "${url}"`,
  ];
  for (const cmd of attempts) {
    try {
      execSync(cmd, { stdio: "inherit" });
      if (fs.existsSync(outPath)) return true;
    } catch (e) {
      // continua para próxima tentativa
    }
  }
  return false;
}

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

        // 1) Modo local/YouTube
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

        // 2) URLs de canais (atualiza em tempo real na struct de config)
        const norm = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s || "").trim()).filter(Boolean);
        const currentList = norm(config.streamUrls || config.urls || []);
        const freshList = norm(fresh.streamUrls || fresh.urls || []);
        const changedChannels =
          currentList.length !== freshList.length ||
          currentList.some((u) => !freshList.includes(u)) ||
          freshList.some((u) => !currentList.includes(u));
        if (changedChannels) {
          if (Object.prototype.hasOwnProperty.call(fresh, "streamUrls")) config.streamUrls = fresh.streamUrls;
          if (Object.prototype.hasOwnProperty.call(fresh, "urls")) config.urls = fresh.urls;
          console.log(`\n[YT] Config alterado: canais => ${freshList.length} (antes ${currentList.length})`);
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

// ===================== WATCH CONFIG (URLs de canais em tempo real) =====================
try {
  let cfgWatchChannelsTimeout = null;
  const norm = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s || "").trim()).filter(Boolean);
  fs.watch("config.json", { persistent: true }, () => {
    clearTimeout(cfgWatchChannelsTimeout);
    cfgWatchChannelsTimeout = setTimeout(() => {
      try {
        const fresh = JSON.parse(fs.readFileSync("config.json", "utf8"));
        const newList = norm(fresh.streamUrls || fresh.urls || []);
        const oldList = norm(config.streamUrls || config.urls || []);
        const changed =
          newList.length !== oldList.length ||
          newList.some((u) => !oldList.includes(u)) ||
          oldList.some((u) => !newList.includes(u));
        if (!changed) return;

        // Atualiza config em memória
        if (Object.prototype.hasOwnProperty.call(fresh, "streamUrls")) config.streamUrls = fresh.streamUrls;
        if (Object.prototype.hasOwnProperty.call(fresh, "urls")) config.urls = fresh.urls;

        // Reset controlado da rodada YT para refletir nova lista de canais
        const keys = new Set(newList.map((u) => channelKeyFromUrl(u)));
        ytRoundState.playedChannelsThisRound = [];
        const pruned = {};
        for (const k of Object.keys(ytRoundState.playedVideosByChannel || {})) {
          if (keys.has(k)) pruned[k] = ytRoundState.playedVideosByChannel[k];
        }
        ytRoundState.playedVideosByChannel = pruned;
        saveYtRoundState();

        console.log(`[YT] Lista de canais atualizada em runtime. Canais ativos: ${[...keys].join(", ")}`);
      } catch (e) {
        console.log("[YT] Erro ao processar mudança de canais:", e?.message || e);
      }
    }, 200);
  });
} catch {}

// ===================== STREAM FOLDER =====================
const streamFolder = path.resolve("stream");
// Limpa a pasta de stream na inicialização para evitar acúmulo (log amigável)
try {
  let removed = 0;
  if (fs.existsSync(streamFolder)) {
    const entries = fs.readdirSync(streamFolder);
    for (const entry of entries) {
      try {
        fs.rmSync(path.join(streamFolder, entry), { recursive: true, force: true });
        removed++;
      } catch {}
    }
    if (removed > 0) console.log(`[STREAM] Limpeza inicial: ${removed} item(ns) removido(s).`);
    else console.log(`[STREAM] Limpeza inicial: nenhum arquivo para limpar.`);
  } else {
    console.log(`[STREAM] Pasta inexistente, será criada agora.`);
  }
  fs.mkdirSync(streamFolder, { recursive: true });
} catch {
  // silêncio para evitar quebra de terminal em plataformas diversas
}

app.use("/stream", express.static(streamFolder, {
  etag: false,
  lastModified: false,
  cacheControl: true,
  maxAge: 0,
}));

// ===================== LIVE HLS (stream enquanto baixa) =====================
const livePipelines = new Map(); // id -> { ffmpeg, ytdlp? }

function stopLivePipeline(id) {
  let stoppedFfmpeg = false;
  let stoppedYtdlp = false;
  try {
    const p = livePipelines.get(id);
    if (p) {
      if (p.ffmpeg) {
        try {
          console.log(`[STREAM] Parando ffmpeg do id=${id} (pid=${p.ffmpeg.pid || 'n/a'})`);
          p.ffmpeg.kill("SIGKILL");
          stoppedFfmpeg = true;
        } catch {}
      }
      if (p.ytdlp) {
        try {
          console.log(`[STREAM] Parando yt-dlp do id=${id} (pid=${p.ytdlp.pid || 'n/a'})`);
          p.ytdlp.kill("SIGKILL");
          stoppedYtdlp = true;
        } catch {}
      }
    }
  } catch {}
  livePipelines.delete(id);
  return { stoppedFfmpeg, stoppedYtdlp };
}

function stopAllLivePipelines(exceptId = null) {
  let totalFfmpeg = 0;
  let totalYtdlp = 0;
  try {
    for (const [k] of livePipelines) {
      if (exceptId && k === exceptId) continue;
      const r = stopLivePipeline(k);
      if (r.stoppedFfmpeg) totalFfmpeg++;
      if (r.stoppedYtdlp) totalYtdlp++;
    }
  } catch {}
  if (totalFfmpeg || totalYtdlp) {
    console.log(`[STREAM] Pipelines encerrados: ffmpeg=${totalFfmpeg}, yt-dlp=${totalYtdlp}`);
  } else {
    console.log(`[STREAM] Nenhum pipeline ativo para encerrar.`);
  }
  return { totalFfmpeg, totalYtdlp };
}

function ensureLiveHLS(id) {
  const folder = path.join(streamFolder, id);
  const m3u8 = path.join(folder, `${id}.m3u8`);
  if (livePipelines.has(id)) return m3u8;

  try {
    fs.mkdirSync(folder, { recursive: true });
    // limpa restos antigos sem apagar pasta do id
    for (const f of fs.readdirSync(folder)) {
      try { fs.unlinkSync(path.join(folder, f)); } catch {}
    }
  } catch {}

  const url = `https://www.youtube.com/watch?v=${id}`;
  // Tenta obter URLs separadas (DASH) para v��deo + ��udio (melhor para stream imediato)
  function getUrls(cmd) {
    try {
      const s = execSync(cmd, { encoding: "utf8" }).trim();
      const lines = s.split(/\r?\n/).filter(Boolean);
      return lines;
    } catch { return []; }
  }
  let vUrl = null;
  // Tentativa 1: web (com EJS)
  if (!vUrl) {
    const v = getUrls(`yt-dlp --js-runtimes node -g -f "bv*[ext=mp4][height<=720]" "${url}"`);
    if (v.length) vUrl = v[0];
  }
  // Tentativa 2: TV client (evita EJS em muitos casos)
  if (!vUrl) {
    const v = getUrls(`yt-dlp --js-runtimes node --extractor-args "youtube:player_client=tv" -g -f "bv*[ext=mp4][height<=720]" "${url}"`);
    if (v.length) vUrl = v[0];
  }
  // Tentativa 3: Android (evita EJS; pode retornar apenas progressivo)
  let directUrl = null;
  if (!vUrl) {
    try {
      const out = execSync(
        `yt-dlp --js-runtimes node --no-cookies --extractor-args "youtube:player_client=android" -f "b[ext=mp4][height<=720]/18" -g "${url}"`,
        { encoding: "utf8" }
      ).trim();
      directUrl = out.split(/\r?\n/)[0] || null;
    } catch {}
  }

  let ffArgs = [];
  if (vUrl) {
    ffArgs = [
      "-y",
      "-i", vUrl,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-force_key_frames", "expr:gte(t,n_forced*6)",
      "-an",
      "-start_number", "0",
      "-hls_time", "6",
      "-hls_list_size", "0",
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+append_list",
      "-hls_segment_filename", path.join(folder, `${id}_%03d.ts`),
      m3u8,
    ];
  } else {
    ffArgs = [
      "-y",
      "-i", directUrl || url,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-force_key_frames", "expr:gte(t,n_forced*6)",
      "-an",
      "-start_number", "0",
      "-hls_time", "6",
      "-hls_list_size", "0",
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+append_list",
      "-hls_segment_filename", path.join(folder, `${id}_%03d.ts`),
      m3u8,
    ];
  }

  const f = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "inherit", "inherit"] });
  function cleanup() {
    stopLivePipeline(id);
  }
  f.on("close", () => cleanup());
  livePipelines.set(id, { ffmpeg: f });
  console.log(`[STREAM] ffmpeg iniciado para id=${id} (pid=${f.pid || 'n/a'})`);
  return m3u8;
}

async function waitForFile(p, timeoutMs = 2000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function waitForHlsReady(id, timeoutMs = 5000) {
  const folder = path.join(streamFolder, id);
  const m3u8 = path.join(folder, `${id}.m3u8`);
  const firstSeg = path.join(folder, `${id}_000.ts`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(firstSeg) && fs.statSync(firstSeg).size > 0 && fs.existsSync(m3u8)) {
        const txt = fs.readFileSync(m3u8, 'utf8');
        if (/#EXTINF:/i.test(txt)) return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

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

    // Preload HLS direto (prioriza DASH; fallback progressivo)
    const folder = path.join(streamFolder, next.id);
    const m3u8 = path.join(folder, `${next.id}.m3u8`);
    if (fs.existsSync(m3u8)) {
      console.log(`✅ (PRELOAD) Já existe HLS para: ${next.id}`);
    } else {
      console.log(`⏳ (PRELOAD) Gerando HLS do próximo vídeo: ${next.id}`);
      fs.mkdirSync(folder, { recursive: true });

      function getUrls(cmd) {
        try { const s = execSync(cmd, { encoding: "utf8" }).trim(); return s.split(/\r?\n/).filter(Boolean); } catch { return []; }
      }
      const url = `https://www.youtube.com/watch?v=${next.id}`;
      let vUrl = null, directUrl = null;
      // web + EJS
      if (!vUrl) {
        const v = getUrls(`yt-dlp --js-runtimes node -g -f "bv*[ext=mp4][height<=720]" "${url}"`);
        if (v.length) vUrl = v[0];
      }
      // TV client
      if (!vUrl) {
        const v = getUrls(`yt-dlp --js-runtimes node --extractor-args "youtube:player_client=tv" -g -f "bv*[ext=mp4][height<=720]" "${url}"`);
        if (v.length) vUrl = v[0];
      }
      
      // Fallback progressivo
      if (!vUrl) {
        try {
          const out = execSync(`yt-dlp --js-runtimes node -g -f "b[ext=mp4][height<=720]/18" "${url}"`, { encoding: "utf8" }).trim();
          directUrl = out.split(/\r?\n/)[0] || null;
        } catch {}
      }

      let ffArgs = [];
      if (vUrl) {
        ffArgs = [
          "-y",
          "-i", vUrl,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-profile:v", "main",
          "-force_key_frames", "expr:gte(t,n_forced*6)",
          "-an",
          "-start_number", "0",
          "-hls_time", "6",
          "-hls_list_size", "0",
          "-hls_playlist_type", "event",
          "-hls_flags", "independent_segments+append_list",
          "-hls_segment_filename", path.join(folder, `${next.id}_%03d.ts`),
          m3u8,
        ];
      } else if (directUrl) {
        ffArgs = [
          "-y",
          "-i", directUrl,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-profile:v", "main",
          "-force_key_frames", "expr:gte(t,n_forced*6)",
          "-an",
          "-start_number", "0",
          "-hls_time", "6",
          "-hls_list_size", "0",
          "-hls_playlist_type", "event",
          "-hls_flags", "independent_segments+append_list",
          "-hls_segment_filename", path.join(folder, `${next.id}_%03d.ts`),
          m3u8,
        ];
      } else {
        console.log(`⚠️ (PRELOAD) Não foi possível obter URLs para: ${next.id}`);
        return;
      }

      try {
        execSync(`ffmpeg ${ffArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, { stdio: "inherit" });
        console.log(`✅ (PRELOAD) Próximo vídeo pronto: ${next.id}`);
      } catch (e) {
        console.log(`⚠️ (PRELOAD) Falha ao gerar HLS para ${next.id}:`, e?.message || e);
        return;
      }
    }
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

    return res.json({ file: escolhido.arquivo, title: escolhido.video });
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
  // Antes de iniciar um novo stream, pare quaisquer pipelines anteriores para evitar acúmulo
  const stopped = stopAllLivePipelines(chosen.id);
  console.log(`[YT] Indo para o próximo vídeo (id=${chosen.id}). Encerrados: ffmpeg=${stopped.totalFfmpeg}, yt-dlp=${stopped.totalYtdlp}`);
  const liveM3U8 = ensureLiveHLS(chosen.id);
  // Esperar o manifest e o primeiro segmento aparecerem
  await waitForHlsReady(chosen.id, 7000);
  console.log(`\n[YT] Canal: ${chKey}`);
  console.log(`[YT] Video: ${chosen.title}  (id=${chosen.id}, age=${chosen.ageDays}d)`);
  preloadNextVideo(chKey);
  return res.json({ hls: `/stream/${chosen.id}/${chosen.id}.m3u8`, id: chosen.id, title: chosen.title, channel: chKey });
});
// 🛑 Blacklist (local + YouTube)
// ==========================================================
app.post("/api/blacklist", async (req, res) => {
  const { id, file } = req.body || {};

  if (id) {
    // Pare stream ativo (se houver) para este vídeo
    try {
      const r = stopLivePipeline(id);
      if (r.stoppedFfmpeg || r.stoppedYtdlp) {
        console.log(`[STREAM] Encerrado(s) para blacklist id=${id}: ffmpeg=${r.stoppedFfmpeg ? 1 : 0}, yt-dlp=${r.stoppedYtdlp ? 1 : 0}`);
      }
    } catch {}
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
// Healthcheck simples (para o player reconectar)
// ==========================================================
app.get("/health", (req, res) => res.json({ ok: true }));

// ==========================================================
// API - Gerenciar canais em tempo real (YouTube)
// ==========================================================
function normalizeList(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function setChannelsRuntime(newList, reason = "runtime") {
  const list = Array.from(new Set(normalizeList(newList)));
  // Atualiza em memória (manter compat: ambos campos)
  config.streamUrls = list;
  config.urls = list;
  // Persistir no arquivo
  try {
    const json = JSON.parse(fs.readFileSync(configPath, "utf8"));
    json.streamUrls = list;
    json.urls = list;
    fs.writeFileSync(configPath, JSON.stringify(json, null, 2), "utf8");
  } catch (e) {
    console.log("[YT] Falha ao salvar config.json:", e?.message || e);
  }

  // Reset de rodada YT coerente com nova lista
  const keys = new Set(list.map((u) => channelKeyFromUrl(u)));
  ytRoundState.playedChannelsThisRound = [];
  const pruned = {};
  for (const k of Object.keys(ytRoundState.playedVideosByChannel || {})) {
    if (keys.has(k)) pruned[k] = ytRoundState.playedVideosByChannel[k];
  }
  ytRoundState.playedVideosByChannel = pruned;
  saveYtRoundState();

  console.log(`[YT] Canais atualizados (${reason}). Total: ${list.length}`);
  return list;
}

app.get("/api/channels", (req, res) => {
  return res.json({ urls: normalizeList(config.streamUrls || config.urls || []) });
});

app.post("/api/channels/add", (req, res) => {
  const incoming = normalizeList(req.body?.urls || (req.body?.url ? [req.body.url] : []));
  if (!incoming.length) return res.status(400).json({ ok: false, error: "informe url(s)" });
  const current = normalizeList(config.streamUrls || config.urls || []);
  const next = Array.from(new Set([...current, ...incoming]));
  const final = setChannelsRuntime(next, "API add");
  return res.json({ ok: true, urls: final });
});

app.post("/api/channels/remove", (req, res) => {
  const incoming = normalizeList(req.body?.urls || (req.body?.url ? [req.body.url] : []));
  if (!incoming.length) return res.status(400).json({ ok: false, error: "informe url(s)" });
  const current = normalizeList(config.streamUrls || config.urls || []);
  const toRemove = new Set(incoming);
  const next = current.filter((u) => !toRemove.has(u));
  const final = setChannelsRuntime(next, "API remove");
  return res.json({ ok: true, urls: final });
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

    // Se for um HLS atual, tente parar o pipeline associado ao ID extraído
    try {
      const maybeId = extractIdFromFilename(path.basename(located));
      if (maybeId) {
        const r = stopLivePipeline(maybeId);
        if (r.stoppedFfmpeg || r.stoppedYtdlp) {
          console.log(`[STREAM] Encerrado(s) para delete file id=${maybeId}: ffmpeg=${r.stoppedFfmpeg ? 1 : 0}, yt-dlp=${r.stoppedYtdlp ? 1 : 0}`);
        }
      }
    } catch {}
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





