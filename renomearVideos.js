// script-renomear-videos.js — versão SEM yt-dlp, com contador "Processando X de Y"

import fs from "fs";
import path from "path";

// Se estiver no Node 18+ você já tem fetch nativo.
// Caso contrário, descomente a linha abaixo:
// import fetch from "node-fetch";

const pastaDownloads = "f:/VIDEOS PARA TELÃO/downloads";

// Remove caracteres proibidos no Windows
function limpar(str) {
  return str
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrator de ID robusto
function extrairID(nome) {
  const regex = /([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g;
  const matches = [...nome.matchAll(regex)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

// Busca HTML
async function buscarHtml(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!res.ok) throw new Error(`Falha ao obter HTML (HTTP ${res.status})`);
  return await res.text();
}

// Extrai título + canal do HTML
function extrairInfo(html) {
  const regex = /ytInitialPlayerResponse\s*=\s*(\{.*?\});/s;
  const match = html.match(regex);

  if (!match) throw new Error("ytInitialPlayerResponse não encontrado");

  const data = JSON.parse(match[1]);

  return {
    titulo: data.videoDetails?.title || "SemTítulo",
    canal: data.videoDetails?.author || "CanalDesconhecido"
  };
}

async function iniciar() {
  console.log("\n🔎 Verificando pasta:", pastaDownloads);

  // Lista todos os arquivos que são .mp4
  const todos = fs.readdirSync(pastaDownloads);
  const arquivos = todos.filter(a => a.toLowerCase().endsWith(".mp4"));

  const total = arquivos.length;
  let indice = 0;

  if (total === 0) {
    console.log("⚠️ Nenhum arquivo .mp4 encontrado.");
    return;
  }

  console.log(`📦 Total de vídeos a processar: ${total}`);

  for (const arquivo of arquivos) {
    indice++;

    console.log(`\n🎞 Processando ${indice} de ${total}: ${arquivo}`);

    const caminhoAntigo = path.join(pastaDownloads, arquivo);
    const id = extrairID(arquivo);

    if (!id) {
      console.log("⚠️ Não foi possível extrair ID desse arquivo.");
      continue;
    }

    console.log(`   → ID detectado: ${id}`);

    try {
      const html = await buscarHtml(id);
      const { titulo, canal } = extrairInfo(html);

      const canalLimpo = limpar(canal);
      const tituloLimpo = limpar(titulo);

      // Detecta parte X
      const matchParte = arquivo.match(/par[te]*\s?(\d+)/i);
      const parte = matchParte ? ` parte ${matchParte[1]}` : "";

      const novoNome = `${canalLimpo} - ${tituloLimpo} - ${id}${parte}.mp4`;
      const caminhoNovo = path.join(pastaDownloads, novoNome);

      fs.renameSync(caminhoAntigo, caminhoNovo);

      console.log("✔️ Renomeado para:");
      console.log("   →", novoNome);

    } catch (e) {
      console.log("❌ Erro ao processar vídeo:");
      console.log("   →", e.message);
    }
  }

  console.log("\n🏁 Finalizado!");
}

iniciar();
