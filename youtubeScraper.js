import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

// prettier-ignore
const URLS = config.urls || [];
const INCLUDE = config.includeKeywords || [];
const EXCLUDE = config.excludeKeywords || [];
const IGNORE_SHORTS = config.ignoreShorts ?? true;
const MIN_DURATION = config.minDurationSeconds || 0;

function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fetchVideosFromUrl(url) {
  console.log(`\n🛰️ INICIANDO VARREDURA DO CANAL/URL: ${url}`);

  const result = spawnSync(
    "yt-dlp",
    ["--dump-json", "--flat-playlist", url],
    { encoding: "utf-8" }
  );

  if (!result.stdout.trim()) {
    console.log("⚠️ Nenhum vídeo retornado pelo yt-dlp para esta URL!");
    return [];
  }

  const lines = result.stdout.trim().split("\n");
  const videos = [];

  for (const line of lines) {
    try {
      const data = JSON.parse(line);

      if (!data.id) continue;

      const v = {
        id: data.id,
        title: sanitize(data.title || ""),
        uploader: sanitize(data.uploader || data.channel || "Canal"),
        duration: data.duration || null,
        url: `https://www.youtube.com/watch?v=${data.id}`,
      };

      // Aqui NÃO filtramos ainda, apenas coletamos
      videos.push(v);
    } catch (err) {
      console.log("⚠️ JSON inválido do yt-dlp:", err);
    }
  }

  console.log(`   📦 Vídeos brutos deste canal/URL: ${videos.length}`);
  return videos;
}

// ==========================================================
// FILTROS (com logs de motivo de rejeição e aceitos)
// ==========================================================
function applyFilters(videos, canalLabel = "") {
  console.log(`\n🧪 APLICANDO FILTROS PARA: ${canalLabel || "canal desconhecido"}`);
  console.log(`   Total bruto neste canal antes dos filtros: ${videos.length}`);

  const filtrados = videos.filter((v) => {
    const titleLower = v.title.toLowerCase();

    // SHORTS
    if (IGNORE_SHORTS && v.duration && v.duration < 60) {
      console.log(`   ⛔ REJEITADO (short < 60s): ${v.title}`);
      return false;
    }

    // DURAÇÃO MÍNIMA
    if (v.duration && v.duration < MIN_DURATION) {
      console.log(
        `   ⛔ REJEITADO (curto < minDuration=${MIN_DURATION}s): ${v.title} dur=${v.duration}`
      );
      return false;
    }

    // PALAVRAS EXCLUÍDAS
    for (const k of EXCLUDE) {
      if (k && titleLower.includes(k.toLowerCase())) {
        console.log(
          `   ⛔ REJEITADO (contém palavra proibida "${k}"): ${v.title}`
        );
        return false;
      }
    }

    // PALAVRAS INCLUÍDAS
    if (INCLUDE.length > 0) {
      const ok = INCLUDE.some(
        (k) => k && titleLower.includes(k.toLowerCase())
      );
      if (!ok) {
        console.log(
          `   ⛔ REJEITADO (não contém nenhuma palavra include): ${v.title}`
        );
        return false;
      }
    }

    console.log(`   ✅ ACEITO: ${v.title}`);
    return true;
  });

  console.log(
    `   📌 Após filtros neste canal: ${filtrados.length} aprovados de ${videos.length} brutos`
  );

  return filtrados;
}

function groupByChannelInto(targetGrouped, videos) {
  for (const v of videos) {
    if (!targetGrouped[v.uploader]) targetGrouped[v.uploader] = [];
    targetGrouped[v.uploader].push(v);
  }
}

// ==========================================================
// PROCESSO PRINCIPAL (POR CANAL)
// ==========================================================
(async () => {
  let grouped = {}; // resultado final agrupado por uploader
  let totalBrutoGlobal = 0;
  let totalFiltradoGlobal = 0;

  for (const url of URLS) {
    const vidsBrutos = fetchVideosFromUrl(url);
    totalBrutoGlobal += vidsBrutos.length;

    // label do canal para os logs dos filtros
    const canalLabel =
      vidsBrutos[0]?.uploader || `URL: ${url}`;

    const vidsFiltrados = applyFilters(vidsBrutos, canalLabel);
    totalFiltradoGlobal += vidsFiltrados.length;

    // adiciona só os filtrados ao objeto final agrupado
    groupByChannelInto(grouped, vidsFiltrados);
  }

  console.log(`\n📦 TOTAL GLOBAL BRUTO (todos canais): ${totalBrutoGlobal}`);
  console.log(`📌 TOTAL GLOBAL APÓS FILTROS: ${totalFiltradoGlobal}`);

  console.log("\n📥 VÍDEOS FINALMENTE ADICIONADOS AO CACHE:");
  Object.keys(grouped).forEach((canal) => {
    console.log(`\n📺 Canal: ${canal}`);
    grouped[canal].forEach((v) => {
      console.log(`   ➕ ${v.title} (${v.id})`);
    });
  });

  // 📂 pega o downloadsPath REAL passado pelo downloadVideos.js
  const downloadsPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve("./downloads");

  const cacheFile = path.join(downloadsPath, "videos_cache.json");

  // garante que a pasta existe
  fs.mkdirSync(downloadsPath, { recursive: true });

  fs.writeFileSync(cacheFile, JSON.stringify(grouped, null, 2));

  console.log(`\n💾 videos_cache.json gerado com sucesso em:`);
  console.log(cacheFile);
})();
