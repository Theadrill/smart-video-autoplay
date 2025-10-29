import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// CONFIGURAÇÕES
// ===============================
const configPath = path.resolve("config.json");
if (!fs.existsSync(configPath)) {
  console.error("❌ config.json não encontrado!");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const DOWNLOADS = path.resolve(config.downloadsPath);
const SELECTED = path.resolve(config.selectedPath);

// ✅ USA O VALOR DO JSON (prioridade absoluta)
const TARGET_GB = Number(config.targetGB) || 40;
const TARGET_BYTES = TARGET_GB * 1024 * 1024 * 1024;

// Garante pasta de destino
if (!fs.existsSync(SELECTED)) fs.mkdirSync(SELECTED, { recursive: true });

let manifest = [];

// ===============================
// LEITURA DOS ARQUIVOS POR CANAL
// ===============================
function parseFileName(file) {
  const [canal, ...resto] = file.split(" - ");
  const nomeRestante = resto.join(" - ");
  const matchParte = nomeRestante.match(/parte\s+(\d+)/i);

  return {
    canal: canal.trim(),
    file,
    parte: matchParte ? parseInt(matchParte[1]) : 1
  };
}

const allFiles = fs.readdirSync(DOWNLOADS).filter(f => f.endsWith(".mp4"));
const canaisMap = {};

for (const file of allFiles) {
  const { canal, parte } = parseFileName(file);
  if (!canaisMap[canal]) canaisMap[canal] = [];
  canaisMap[canal].push({ file, parte });
}

// Ordenar alfabeticamente dentro de cada canal
for (const canal of Object.keys(canaisMap)) {
  canaisMap[canal].sort((a, b) => {
    if (a.parte !== b.parte) return a.parte - b.parte;
    return a.file.localeCompare(b.file);
  });
}

// ===============================
// CICLOS POR PARTES
// ===============================
let totalBytes = 0;
let currentParte = 1;
let arquivosRestantes = true;

while (arquivosRestantes && totalBytes < TARGET_BYTES) {
  arquivosRestantes = false;

  for (const canal of Object.keys(canaisMap)) {
    const arquivosDoCanal = canaisMap[canal];
    const candidatos = arquivosDoCanal.filter(f => f.parte === currentParte);

    for (const c of candidatos) {
      arquivosRestantes = true;

      const src = path.join(DOWNLOADS, c.file);
      const stats = fs.statSync(src);
      const size = stats.size;

      // ✅ Permite ultrapassar (opção escolhida)
      if (totalBytes >= TARGET_BYTES) break;

      const dest = path.join(SELECTED, c.file);
      fs.copyFileSync(src, dest);
      totalBytes += size;

      manifest.push({
        canal,
        file: c.file,
        sizeMB: (size / (1024 * 1024)).toFixed(2)
      });

      console.log(`✅ Copiado: ${c.file} | ${(totalBytes / (1024 ** 3)).toFixed(2)} GB acumulado`);
    }
  }

  currentParte++;
}

// Salvar manifesto
fs.writeFileSync(
  path.join(SELECTED, "selected_manifest.json"),
  JSON.stringify({
    targetGB: TARGET_GB,
    finalGB: (totalBytes / (1024 ** 3)).toFixed(2),
    videos: manifest
  }, null, 2)
);

console.log("\n🎉 FINALIZADO!");
console.log(`📦 Total copiado: ${(totalBytes / (1024 ** 3)).toFixed(2)} GB`);
console.log(`📁 Destino: ${SELECTED}`);
console.log("📝 Manifesto salvo em selected_manifest.json\n");
