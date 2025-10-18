import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.static("public"));

const downloadsPath = path.resolve("downloads");
const playedFile = path.resolve("played.json");

function readPlayed() {
  try {
    return JSON.parse(fs.readFileSync(playedFile, "utf8"));
  } catch {
    return [];
  }
}

function writePlayed(list) {
  fs.writeFileSync(playedFile, JSON.stringify(list, null, 2));
}

// Endpoint - retorna o próximo vídeo
app.get("/api/next", (req, res) => {
  const allVideos = fs.readdirSync(downloadsPath).filter(f => f.endsWith(".mp4"));
  let played = readPlayed();

  // Filtra os vídeos ainda não tocados
  const remaining = allVideos.filter(v => !played.includes(v));

  // Reseta se acabou
  if (remaining.length === 0) {
    played = [];
    writePlayed(played);
    return res.json({ reset: true, file: null });
  }

  // Escolhe um aleatório entre os remanescentes
  const chosen = remaining[Math.floor(Math.random() * remaining.length)];
  played.push(chosen);
  writePlayed(played);

  res.json({ file: chosen });
});

// Servidor de arquivos
app.get("/video/:name", (req, res) => {
  const filePath = path.join(downloadsPath, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).send("Arquivo não encontrado");
  res.sendFile(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando: http://localhost:${PORT}`);
});
