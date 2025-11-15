// script-renomear-videos.js – versão robusta para TODOS os formatos

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const pastaDownloads = "f:/VIDEOS PARA TELÃO/downloads";

// Remove caracteres proibidos no Windows
function limpar(str) {
  return str
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// =============================
// NOVO EXTRATOR DE ID ROBUSTO
// =============================
function extrairID(nome) {
  // Padrão OFICIAL do YouTube: exatamente 11 caracteres
  // Letras maiúsculas/minúsculas, números, underline e hífen
  const regex = /([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g;

  const matches = [...nome.matchAll(regex)];

  if (matches.length === 0) return null;

  // Se tiver mais de um ID no nome, quase sempre o último é o correto
  return matches[matches.length - 1][1];
}

async function iniciar() {
  console.log("\n🔎 Verificando pasta:", pastaDownloads);

  const arquivos = fs.readdirSync(pastaDownloads);

  for (const arquivo of arquivos) {
    const caminhoAntigo = path.join(pastaDownloads, arquivo);

    if (!arquivo.toLowerCase().endsWith(".mp4")) {
      console.log("⏭ Ignorando:", arquivo);
      continue;
    }

    const id = extrairID(arquivo);

    if (!id) {
      console.log("⚠️ Não foi possível extrair ID de:", arquivo);
      continue;
    }

    console.log(`\n🎞 Processando: ${arquivo}`);
    console.log(`   → ID detectado: ${id}`);

    try {
      // Pega o JSON do vídeo
      const json = execSync(
        `yt-dlp --sleep-requests 2 --dump-json https://www.youtube.com/watch?v=${id}`,
        { encoding: "utf-8" }
      );

      const info = JSON.parse(json);
      const canal = limpar(info.channel || info.uploader || "CanalDesconhecido");
      const titulo = limpar(info.title || "SemTítulo");

      // Busca qualquer "parte X" mesmo com erros
      const matchParte = arquivo.match(/par+te\s?(\d+)/i);
      const parte = matchParte ? ` parte ${matchParte[1]}` : "";

      const novoNome = `${canal} - ${titulo} - ${id}${parte}.mp4`;
      const caminhoNovo = path.join(pastaDownloads, novoNome);

      fs.renameSync(caminhoAntigo, caminhoNovo);

      console.log("✔️ Renomeado para:");
      console.log("   →", novoNome);

    } catch (e) {
      console.log("❌ Erro ao obter metadados do vídeo:", e.message);
    }
  }

  console.log("\n🏁 Finalizado!");
}

iniciar();
