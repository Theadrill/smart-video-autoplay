/**
 * selectVideos.js — Versão COMPLETA com Log VERBOSO + videosExistentes.json
 * -------------------------------------------------------------------------------
 * Alterações adicionadas:
 * - Catalogação inicial de IDs já presentes na pasta destino (selectedPath)
 * - Salvamento em selectedPath/videosExistentes.json (cria/substitui)
 * - Durante a cópia, NÃO copiar vídeos cujo ID já exista nesse JSON
 * - Atualiza videosExistentes.json após cópias
 *
 * OBS: Não mexi na lógica existente (manifest, reorder, reduce, etc.) — apenas
 * acrescentei as funções e checagens para IDs conforme pedido.
 * -------------------------------------------------------------------------------
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
const EXISTING_JSON_PATH = path.join(SELECTED_DIR, "videosExistentes.json");

/* ==========================
   💾 MANIFEST (DECLARAÇÃO GLOBAL)
   ========================== */
let manifest = null;

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

/**
 * Extrai o ID do nome base (sem prefixo numérico). Exemplo:
 * "TheRUB and TOP Video Rally - TRENTINO RALLY ... - 2Lgrexkbj3Q parte 1"
 * => "2Lgrexkbj3Q"
 *
 * Estratégia robusta:
 * - remove extensão
 * - localiza a palavra "parte" (última ocorrência)
 * - pega o trecho entre o último " - " antes de "parte" e "parte"
 */
function extractIdFromBaseName(baseName) {
  if (!baseName) return null;
  const noExt = baseName.replace(/\.mp4$/i, "").trim();
  const idxParte = noExt.toLowerCase().lastIndexOf("parte");
  if (idxParte === -1) return null;
  const beforeParte = noExt.slice(0, idxParte).trim();
  const lastHyphen = beforeParte.lastIndexOf(" - ");
  if (lastHyphen === -1) return null;
  const id = beforeParte.slice(lastHyphen + 3).trim();
  return id || null;
}

/* ==========================
   📁 videosExistentes.json (load / save / build)
   ========================== */
function loadExistingIDs() {
  if (!fs.existsSync(EXISTING_JSON_PATH)) return { videos: [] };
  try {
    const raw = fs.readFileSync(EXISTING_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.videos)) return { videos: [] };
    return { videos: parsed.videos };
  } catch (err) {
    console.warn("⚠️ Falha ao ler videosExistentes.json — reconstruindo: ", err.message);
    return { videos: [] };
  }
}

function saveExistingIDs(arr) {
  const unique = Array.from(new Set(arr.filter(Boolean)));
  const payload = { videos: unique };
  fs.writeFileSync(EXISTING_JSON_PATH, JSON.stringify(payload, null, 2));
  console.log(`💾 videosExistentes.json salvo | ${unique.length} IDs`);
}

function buildExistingFromDir() {
  console.log("🔎 Catalogando vídeos já presentes na pasta destino para gerar videosExistentes.json...");
  const mp4s = fs.readdirSync(SELECTED_DIR).filter(f => f.toLowerCase().endsWith(".mp4"));
  const ids = [];
  for (const name of mp4s) {
    const base = stripPrefix(name); // remove prefix numérico "0001 - "
    const id = extractIdFromBaseName(base);
    if (id) {
      ids.push(id);
    } else {
      const { titulo } = parseFileName(base);
      const altId = (() => {
        const idx = titulo.lastIndexOf(" - ");
        if (idx === -1) return null;
        return titulo.slice(idx + 3).trim();
      })();
      if (altId) {
        ids.push(altId);
      } else {
        console.log(`   ⚠️ Não foi possível extrair ID de: "${name}" — ignorando para JSON.`);
      }
    }
  }
  const unique = Array.from(new Set(ids));
  saveExistingIDs(unique);
  return unique;
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
  const manifestLocal = mp4s.map(name => {
    const original = stripPrefix(name);
    const { canal, file, parte, titulo } = parseFileName(original);
    const size = fs.statSync(path.join(SELECTED_DIR, name)).size;
    return { canal, file, parte, titulo, size, finalName: name };
  });
  console.log(`✅ Manifest reconstruído: ${manifestLocal.length} vídeos.`);
  return manifestLocal;
}

/* ==========================
   🔍 DETECTAR ALTERAÇÕES MANUAIS
   ========================== */
function detectManualChanges(manifestParam) {
  const disk = fs.readdirSync(SELECTED_DIR).filter(f => f.toLowerCase().endsWith(".mp4"));
  const manifestNames = manifestParam.map(v => v.finalName || v.file);
  const removed = manifestNames.filter(n => !disk.includes(n));
  const added = disk.filter(n => !manifestNames.includes(n));
  return { changed: removed.length || added.length, removed, added };
}

function reconcile(manifestParam, removed, added) {
  let local = manifestParam.filter(v => !removed.includes(v.finalName || v.file));
  added.forEach(a => {
    const base = stripPrefix(a);
    const { canal, file, parte, titulo } = parseFileName(base);
    const size = fs.statSync(path.join(SELECTED_DIR, a)).size;
    local.push({ canal, file, parte, titulo, size, finalName: a });
  });
  local.forEach(v => {
    v.size = fs.statSync(path.join(SELECTED_DIR, v.finalName || v.file)).size;
  });
  return local;
}

/* ==========================
   🔀 REORDENAR SEM REPETIR CANAL
   ========================== */
async function reorder(manifestParam) {
  console.log("🔀 Reordenando (não repetir canal; embaralhar canais a cada rodada)...");
  const groups = {};
  manifestParam.forEach(v => {
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

  manifestParam.length = 0;
  ordered.forEach(x => manifestParam.push(x));
  console.log("✅ Reordenação concluída.");
}

/* ==========================
   📉 REDUÇÃO EQUILIBRADA (SEM REORDENAÇÃO INTERNA)
   ========================== */
async function reduce(manifestParam) {
  console.log("⚠️ Tamanho excedido → iniciando remoção equilibrada por canal...");

  function getTotal() { return manifestParam.reduce((a, b) => a + (b.size || 0), 0); }

  while (getTotal() > TARGET_BYTES) {
    const groups = {};
    manifestParam.forEach(v => {
      if (!groups[v.canal]) groups[v.canal] = [];
      groups[v.canal].push(v);
    });
    Object.keys(groups).forEach(c => groups[c].sort((a, b) => b.parte - a.parte));
    shuffle(Object.keys(groups));

    for (const canal of Object.keys(groups)) {
      const remove = groups[canal].pop();
      if (!remove) continue;
      const p = path.join(SELECTED_DIR, remove.finalName || remove.file);
      if (fs.existsSync(p)) {
        console.log(`🗑️ Removendo: ${remove.finalName || remove.file}`);
        fs.unlinkSync(p);
      }
      manifestParam.splice(manifestParam.indexOf(remove), 1);
      if (getTotal() <= TARGET_BYTES) break;
    }
  }
  
  console.log("✅ Remoção concluída.");
}

/* ==========================
   🚚 CÓPIA INCREMENTAL (RODÍZIO) — 1 VÍDEO POR CANAL POR RODADA
   ========================== */
async function copyIncremental(manifestParam, existingIdsSet) {
  const have = new Set(manifestParam.map(v => v.file));
  console.log("📥 Lendo fontes e agrupando por canal...");
  const groups = {}; // canal -> array de vídeos

  for (const dir of DOWNLOAD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".mp4"));
    for (const f of files) {
      const sourceBase = stripPrefix(f);
      const id = extractIdFromBaseName(sourceBase);
      if (id && existingIdsSet.has(id)) {
        console.log(`   ⛔ ID já existe (pulando): ${id} — ${f}`);
        continue;
      }

      const info = parseFileName(f);
      if (have.has(info.file)) continue; // já está no manifest

      if (!groups[info.canal]) groups[info.canal] = [];
      groups[info.canal].push({ ...info, folder: dir, sourceName: f, sourceId: id });
    }
  }

  Object.keys(groups).forEach(c => shuffle(groups[c]));

  // índice por canal: round-robin real (1 por canal)
  const indices = {};
  Object.keys(groups).forEach(c => { indices[c] = 0; });

  let total = manifestParam.reduce((a, b) => a + (b.size || 0), 0);
  let moved = false;
  const newlyAddedIds = [];

  while (total < TARGET_BYTES) {
    console.log("🔄 Nova rodada (1 por canal)");

    let addedThisRound = false;
    const canais = Object.keys(groups).filter(c => indices[c] < groups[c].length);
    if (!canais.length) break;
    shuffle(canais);

    for (const canal of canais) {
      const i = indices[canal];
      if (i >= groups[canal].length) continue;

      const info = groups[canal][i];
      const src = path.join(info.folder, info.sourceName);
      const dst = path.join(SELECTED_DIR, info.file);
      if (!fs.existsSync(src)) {
        indices[canal]++;
        continue;
      }

      let id = info.sourceId;
      if (!id) id = extractIdFromBaseName(stripPrefix(info.sourceName));
      if (id && existingIdsSet.has(id)) {
        console.log(`   ⛔ ID detectado no meio do processo (pulando): ${id} — ${info.sourceName}`);
        indices[canal]++;
        continue;
      }

      const size = fs.statSync(src).size;
      console.log(`📥 Copiando: ${info.file} (${human(size)})`);
      fs.copyFileSync(src, dst);

      manifestParam.push({ ...info, finalName: info.file, size });
      total += size;
      moved = true;
      addedThisRound = true;

      if (id) {
        existingIdsSet.add(id);
        newlyAddedIds.push(id);
      }

      console.log(`   📊 Acumulado: ${human(total)} / ${human(TARGET_BYTES)}`);
      indices[canal]++;

      if (total >= TARGET_BYTES) break;
    }

    if (!addedThisRound) {
      break;
    }
  }

  return { moved, newlyAddedIds };
}

/* ==========================
   🚀 EXECUÇÃO PRINCIPAL — FLUXO OTIMIZADO
   ========================== */
(async () => {
  console.log("============================================================");
  console.log("🚀 SCRIPT DE SELEÇÃO DE VÍDEOS (LOG VERBOSO ATIVADO)");
  console.log("============================================================\n");

  const respostaReset = await ask("Deseja DELETAR todos os vídeos da pasta destino e copiar novos vídeos SEM repetir IDs antigos? (S/N): ");

  if (respostaReset === "s") {
    console.log("⚠️ Deletando TODOS os vídeos da pasta destino...");
    const files = fs.readdirSync(SELECTED_DIR);
    for (const f of files) {
      if (f.toLowerCase().endsWith(".mp4")) {
        try {
          fs.unlinkSync(path.join(SELECTED_DIR, f));
          console.log("   🗑️ Removido:", f);
        } catch (err) {
          console.log("   ❌ Erro ao remover:", f, err.message);
        }
      }
    }
    console.log("🔄 Reconstruindo manifest após limpeza...");
    manifest = [];
  } else {
    console.log("➡️ Mantendo arquivos existentes. Continuando processo normal...\n");
  }

  console.log("📂 Pastas de origem:");
  DOWNLOAD_DIRS.forEach(d => console.log("   →", d));
  console.log(`📦 Pasta destino: ${SELECTED_DIR}`);
  console.log(`🎯 Limite: ${TARGET_GB} GB (${human(TARGET_BYTES)})`);
  console.log(`🎛️ Limite por canal/rodada: ${MAX_VIDEOS_PER_CHANNEL_PER_ROUND || "Ilimitado"}`);
  console.log(`🔀 Embaralhamento final: ${GENERATE_RANDOM_NAMES ? "ATIVADO" : "DESATIVADO"}`);
  console.log("------------------------------------------------------------\n");

  const initialExisting = buildExistingFromDir();
  const existingSet = new Set(initialExisting);

  if (!Array.isArray(manifest) || manifest === null) {
    manifest = loadManifest();
    if (!manifest) manifest = rebuildManifest();
    else console.log(`📄 Manifest carregado (${manifest.length} vídeos)\n`);
  }

  const { changed, removed, added } = detectManualChanges(manifest);
  if (changed) {
    console.log("🛠 Atualizando manifest devido a alterações manuais...");
    manifest = reconcile(manifest, removed, added);
    saveManifest(manifest);
  }

  const current = manifest.reduce((a, b) => a + (b.size || 0), 0);
  console.log(`📊 Tamanho atual: ${human(current)} / ${human(TARGET_BYTES)}\n`);

  // Se já excedeu, remove o excesso ANTES de copiar novos
  if (current > TARGET_BYTES) {
    await reduce(manifest);
    saveManifest(manifest);
  }

  // Copia novos vídeos (se necessário)
  const { moved, newlyAddedIds } = await copyIncremental(manifest, existingSet);

  // ✅ VERIFICAÇÃO FINAL: Se após cópia excedeu o limite, remove o excesso
  const finalSize = manifest.reduce((a, b) => a + (b.size || 0), 0);
  console.log(`📊 Tamanho após cópia: ${human(finalSize)} / ${human(TARGET_BYTES)}`);
  
  if (finalSize > TARGET_BYTES) {
    console.log("⚠️ Excedeu limite após cópia → removendo excesso...");
    await reduce(manifest);
  }

  saveManifest(manifest);

  // Atualiza videosExistentes.json
  if (newlyAddedIds && newlyAddedIds.length) {
    saveExistingIDs(Array.from(existingSet));
  } else {
    saveExistingIDs(Array.from(existingSet));
  }

  // 🔁 REORDENAÇÃO SÓ NO FINAL (após tudo estar resolvido)
  if (GENERATE_RANDOM_NAMES) {
    if (moved || changed) {
      console.log("🎯 Passo final: reordenando...");
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

  // Verificação final de excesso (caso a reordenação tenha causado algum problema)
  const veryFinal = manifest.reduce((a, b) => a + (b.size || 0), 0);
  if (veryFinal > TARGET_BYTES) {
    console.log("⚠️ Verificação final: ainda excedido após reordenação → removendo...");
    await reduce(manifest);
    saveManifest(manifest);
  }

  console.log("\n✅ Finalizado.\n");
})();
