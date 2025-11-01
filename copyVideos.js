/**
 * selectVideos.js — Versão COMPLETA com Log VERBOSO
 * ------------------------------------------------------------------------------
 * Este script copia vídeos das pastas originais (downloadsPath[]) para a pasta
 * final (selectedPath), levando em conta limite de GB, rodízio por partes,
 * limite por canal por rodada, embaralhamento final sem repetir canal,
 * prefixação numérica, manifest incremental, reembalhamento e redução equilibrada.
 *
 * Logs são EXTREMAMENTE descritivos. Se a TV Box for fraca, recomenda-se rodar
 * isso no PC antes de copiar para ela.
 * ------------------------------------------------------------------------------
 */

import fs from "fs";
import path from "path";
import readline from "readline";

/* ==========================
   📂 CARREGAR CONFIG
   ========================== */
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

const DOWNLOAD_DIRS = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map(p => path.resolve(p))
  : [path.resolve(config.downloadsPath)];

const SELECTED_DIR = path.resolve(config.selectedPath);
if (!fs.existsSync(SELECTED_DIR)) fs.mkdirSync(SELECTED_DIR, { recursive: true });

const TARGET_GB = Number(config.targetGB) || 40;
const TARGET_BYTES = TARGET_GB * 1024 * 1024 * 1024;

const GENERATE_RANDOM_NAMES = config.generateRandomNames === true;
const MAX_VIDEOS_PER_CHANNEL_PER_ROUND = Number(config.maxVideosPerChannelPerRound) || 0;

const MANIFEST_PATH = path.join(SELECTED_DIR, "selected_manifest.json");

/* ==========================
   🧰 FUNÇÕES ÚTEIS
   ========================== */
function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i < 2 ? 0 : 2)} ${u[i]}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function ask(q) {
  return new Promise(r => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => {
      rl.close();
      r(ans.trim().toLowerCase());
    });
  });
}

/* ==========================
   🔎 PARSE DE NOME DE ARQUIVO
   ========================== */
function stripPrefix(name) {
  return name.replace(/^\d{4}\s*-\s*/, "").trim();
}

function parseFileName(name) {
  const noExt = name.replace(/\.mp4$/i, "");
  const parts = noExt.split(" - ");
  const canal = parts[0]?.trim() || "Desconhecido";

  const resto = parts.slice(1).join(" - ");
  const matchP = resto.match(/parte\s+(\d+)/i);
  let parte = 1;
  let titulo = resto;

  if (matchP) {
    parte = parseInt(matchP[1], 10);
    titulo = resto.replace(matchP[0], "").trim();
  }

  const original = `${canal} - ${titulo}${matchP ? ` parte ${parte}` : ""}.mp4`;
  return { canal, file: original, titulo, parte };
}

/* ==========================
   💾 MANIFEST
   ========================== */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).videos || null;
  } catch {
    return null;
  }
}

function saveManifest(list) {
  const total = list.reduce((a, b) => a + (b.size || 0), 0);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
    targetGB: TARGET_GB,
    finalGB: (total / (1024 ** 3)).toFixed(2),
    count: list.length,
    videos: list
  }, null, 2));
  console.log(`💾 Manifest salvo  |  ${list.length} vídeos  |  ${human(total)}`);
}

function rebuildManifest() {
  console.log("⚠️ Manifest ausente → reconstruindo a partir da pasta destino...");
  const mp4s = fs.readdirSync(SELECTED_DIR).filter(f => f.toLowerCase().endsWith(".mp4"));
  const manifest = mp4s.map(name => {
    const original = stripPrefix(name);
    const { canal, file, parte, titulo } = parseFileName(original);
    const size = fs.statSync(path.join(SELECTED_DIR, name)).size;
    return { canal, file, parte, titulo, size, finalName: name };
  });
  console.log(`✅ Manifest reconstruído: ${manifest.length} vídeos.`);
  return manifest;
}

/* ==========================
   🔍 DETECTAR ALTERAÇÕES MANUAIS
   ========================== */
function detectManualChanges(manifest) {
  const disk = fs.readdirSync(SELECTED_DIR).filter(f => f.toLowerCase().endsWith(".mp4"));
  const manifestNames = manifest.map(v => v.finalName || v.file);

  const removed = manifestNames.filter(n => !disk.includes(n));
  const added = disk.filter(n => !manifestNames.includes(n));

  return { changed: removed.length || added.length, removed, added };
}

function reconcile(manifest, removed, added) {
  manifest = manifest.filter(v => !removed.includes(v.finalName || v.file));
  added.forEach(a => {
    const base = stripPrefix(a);
    const { canal, file, parte, titulo } = parseFileName(base);
    const size = fs.statSync(path.join(SELECTED_DIR, a)).size;
    manifest.push({ canal, file, parte, titulo, size, finalName: a });
  });
  manifest.forEach(v => {
    v.size = fs.statSync(path.join(SELECTED_DIR, v.finalName || v.file)).size;
  });
  return manifest;
}

/* ==========================
   🔀 REORDENAR SEM REPETIR CANAL
   ========================== */
async function reorder(manifest) {
  console.log("🔀 Reordenando (não repetir canal; embaralhar canais a cada rodada)...");
  const groups = {};
  manifest.forEach(v => {
    if (!groups[v.canal]) groups[v.canal] = [];
    groups[v.canal].push(v);
  });
  Object.keys(groups).forEach(c => shuffle(groups[c]));

  const ordered = [];
  while (true) {
    const vivos = Object.keys(groups).filter(c => groups[c].length);
    if (!vivos.length) break;
    shuffle(vivos);
    vivos.forEach(c => {
      const item = groups[c].shift();
      if (item) ordered.push(item);
    });
  }

  let idx = 1;
  ordered.forEach(v => {
    const prefix = String(idx).padStart(4, "0");
    const oldName = v.finalName || v.file;
    const oldPath = path.join(SELECTED_DIR, oldName);
    const newName = `${prefix} - ${v.file}`;
    const newPath = path.join(SELECTED_DIR, newName);
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    v.finalName = newName;
    idx++;
  });

  manifest.length = 0;
  ordered.forEach(x => manifest.push(x));
  console.log("✅ Reordenação concluída.");
}

/* ==========================
   📉 REDUÇÃO EQUILIBRADA
   ========================== */
async function reduce(manifest) {
  console.log("⚠️ Tamanho excedido → iniciando remoção equilibrada por canal...");

  function getTotal() { return manifest.reduce((a, b) => a + (b.size || 0), 0); }

  while (getTotal() > TARGET_BYTES) {
    const groups = {};
    manifest.forEach(v => {
      if (!groups[v.canal]) groups[v.canal] = [];
      groups[v.canal].push(v);
    });
    Object.keys(groups).forEach(c => groups[c].sort((a, b) => b.parte - a.parte)); // remover últimas partes primeiro
    shuffle(Object.keys(groups));

    for (const canal of Object.keys(groups)) {
      const remove = groups[canal].pop();
      if (!remove) continue;
      const p = path.join(SELECTED_DIR, remove.finalName || remove.file);
      if (fs.existsSync(p)) {
        console.log(`🗑️ Removendo: ${remove.finalName || remove.file}`);
        fs.unlinkSync(p);
      }
      manifest.splice(manifest.indexOf(remove), 1);
      if (getTotal() <= TARGET_BYTES) break;
    }
  }

  console.log("♻️ Reordenando após remoção...");
  await reorder(manifest);
  saveManifest(manifest);
}

/* ==========================
   🚚 CÓPIA INCREMENTAL (RODÍZIO)
   ========================== */
async function copyIncremental(manifest) {
  const have = new Set(manifest.map(v => v.file));

  console.log("📥 Lendo fontes e agrupando por canal e parte...");
  const groups = {};

  for (const dir of DOWNLOAD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".mp4"));
    for (const f of files) {
      const info = parseFileName(f);
      if (have.has(info.file)) continue;
      if (!groups[info.canal]) groups[info.canal] = {};
      if (!groups[info.canal][info.parte]) groups[info.canal][info.parte] = [];
      groups[info.canal][info.parte].push({ ...info, folder: dir });
    }
  }

  Object.keys(groups).forEach(c =>
    Object.keys(groups[c]).forEach(p => shuffle(groups[c][p]))
  );

  let total = manifest.reduce((a, b) => a + (b.size || 0), 0);
  let parteAtual = 1;
  let moved = false;

  while (total < TARGET_BYTES) {
    console.log(`🔄 Rodada — Parte ${parteAtual}`);

    let addedThisRound = false;
    for (const canal of Object.keys(groups)) {
      let list = groups[canal][parteAtual];
      if (!list || !list.length) continue;

      const take = MAX_VIDEOS_PER_CHANNEL_PER_ROUND === 0
        ? list.length
        : Math.min(list.length, MAX_VIDEOS_PER_CHANNEL_PER_ROUND);

      const pick = list.splice(0, take);

      for (const info of pick) {
        const src = path.join(info.folder, info.file);
        const dst = path.join(SELECTED_DIR, info.file);
        if (!fs.existsSync(src)) continue;

        const size = fs.statSync(src).size;
        console.log(`📥 Copiando: ${info.file} (${human(size)})`);
        fs.copyFileSync(src, dst);

        manifest.push({ ...info, finalName: info.file, size });
        total += size;
        moved = true;
        addedThisRound = true;

        console.log(`   📊 Acumulado: ${human(total)} / ${human(TARGET_BYTES)}`);
        if (total >= TARGET_BYTES) break;
      }
    }

    if (!addedThisRound) {
      parteAtual++;
      const existsNext = Object.keys(groups).some(
        c => groups[c][parteAtual] && groups[c][parteAtual].length
      );
      if (!existsNext) break;
    }
  }

  return moved;
}

/* ==========================
   🚀 EXECUÇÃO PRINCIPAL
   ========================== */
(async () => {
  console.log("============================================================");
  console.log("🚀 SCRIPT DE SELEÇÃO DE VÍDEOS (LOG VERBOSO ATIVADO)");
  console.log("============================================================\n");

  console.log("📂 Pastas de origem:");
  DOWNLOAD_DIRS.forEach(d => console.log("   →", d));
  console.log(`📦 Pasta destino: ${SELECTED_DIR}`);
  console.log(`🎯 Limite: ${TARGET_GB} GB (${human(TARGET_BYTES)})`);
  console.log(`🎛️ Limite por canal/rodada: ${MAX_VIDEOS_PER_CHANNEL_PER_ROUND || "Ilimitado"}`);
  console.log(`🔀 Embaralhamento final: ${GENERATE_RANDOM_NAMES ? "ATIVADO" : "DESATIVADO"}`);
  console.log("------------------------------------------------------------\n");

  let manifest = loadManifest();
  if (!manifest) manifest = rebuildManifest();
  else console.log(`📄 Manifest carregado (${manifest.length} vídeos)\n`);

  const { changed, removed, added } = detectManualChanges(manifest);
  if (changed) {
    console.log("🛠 Atualizando manifest devido a alterações manuais...");
    manifest = reconcile(manifest, removed, added);
    saveManifest(manifest);
  }

  const current = manifest.reduce((a, b) => a + (b.size || 0), 0);
  console.log(`📊 Tamanho atual: ${human(current)} / ${human(TARGET_BYTES)}\n`);

  if (current > TARGET_BYTES) {
    await reduce(manifest);
    process.exit(0);
  }

  const moved = await copyIncremental(manifest);
  saveManifest(manifest);

  if (GENERATE_RANDOM_NAMES) {
    if (moved || changed) {
      console.log("🔁 Reordenando automaticamente (novos vídeos ou mudanças detectadas)...");
      await reorder(manifest);
      saveManifest(manifest);
    } else {
      const ans = await ask("Nenhuma alteração. Re-embaralhar mesmo assim? (y/n): ");
      if (ans === "y") {
        await reorder(manifest);
        saveManifest(manifest);
      }
    }
  }

  const final = manifest.reduce((a, b) => a + (b.size || 0), 0);
  if (final > TARGET_BYTES) await reduce(manifest);

  console.log("\n✅ Finalizado.\n");
})();
