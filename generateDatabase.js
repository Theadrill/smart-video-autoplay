import fs from "fs";
import path from "path";

// Lê config.json
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"));

// Agora downloadsPath é uma ARRAY
const DOWNLOAD_DIRS = Array.isArray(config.downloadsPath)
  ? config.downloadsPath.map(p => path.resolve(p))
  : [path.resolve(config.downloadsPath)];

const DB_PATH = path.resolve("database.json");

// Função principal
function generateDatabase() {
  let files = [];

  // 🔥 Agora coletamos arquivos de TODAS as pastas originais
  for (const dir of DOWNLOAD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    files.push(...fs.readdirSync(dir).filter(f => f.endsWith(".mp4")));
  }

  // Remove duplicados
  files = [...new Set(files)];

  // Agrupa vídeos por canal
  const canais = {};

  function parse(fileName) {
    const [canal, ...resto] = fileName.split(" - ");
    return {
      canal: (canal || "Desconhecido").trim(),
      video: resto.join(" - ").replace(/\.mp4$/i, "").trim(),
      arquivo: fileName
    };
  }

  for (const f of files) {
    const { canal, video, arquivo } = parse(f);
    if (!canais[canal]) canais[canal] = [];
    canais[canal].push({ video, arquivo });
  }

  // Ordena vídeos por nome
  for (const canal in canais) {
    canais[canal] = canais[canal].sort((a, b) => a.video.localeCompare(b.video));
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(canais, null, 2));
  console.log("✅ database.json reconstruído com sucesso.");
}

generateDatabase();
