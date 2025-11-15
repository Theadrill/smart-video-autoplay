// ============================================================
// renomearVideos.js — com fallback noembed + yt-dlp + HTML
// ============================================================

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { spawnSync } from "child_process";

const pastaDownloads = "f:/VIDEOS PARA TELÃO/downloads";
const logPath = "log.txt";
const cookiesPath = "./cookies.txt"; // já existe no seu projeto

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function sleepRandom(minMs, maxMs) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    return sleep(ms);
}

const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/118 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) Gecko/20100101 Firefox/122.0"
];

function logErro(txt) {
    const linha = `[${new Date().toISOString()}] ${txt}\n`;
    fs.appendFileSync(logPath, linha, "utf8");
}

function limpar(str) {
    return str.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

function extrairID(nome) {
    const regex = /([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g;
    const arr = [...nome.matchAll(regex)];
    return arr.length ? arr[arr.length - 1][1] : null;
}

function nomeJaTemCanal(nome) {
    if (nome.startsWith("Canal -")) return false;
    if (nome.startsWith("CanalDesconhecido -")) return false;
    return true;
}

function extrairTituloECanal_HTML(html) {
    let canal =
        html.match(/"ownerChannelName":"(.*?)"/)?.[1] ??
        html.match(/"channelName":"(.*?)"/)?.[1] ??
        null;

    let titulo =
        html.match(/"title":"(.*?)"/)?.[1] ??
        html.match(/<title>(.*?)<\/title>/)?.[1] ??
        null;

    return { canal, titulo };
}

// ============================================================
// 1º FALLBACK — noembed.com
// ============================================================
async function tentarViaNoEmbed(id) {
    try {
        const url = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`;
        const resp = await fetch(url);
        if (!resp.ok) return null;

        const data = await resp.json();

        if (data.title && data.author_name) {
            return {
                canal: limpar(data.author_name),
                titulo: limpar(data.title)
            };
        }

        return null;
    } catch {
        return null;
    }
}

// ============================================================
// 2º FALLBACK — yt-dlp dump-json
// ============================================================
function tentarViaYtDlp(id) {
    try {
        const result = spawnSync("yt-dlp", ["-J", `https://www.youtube.com/watch?v=${id}`, "--cookies", cookiesPath], {
            encoding: "utf8"
        });

        if (!result.stdout) return null;

        const json = JSON.parse(result.stdout);

        const canal = json?.uploader || json?.channel;
        const titulo = json?.title;

        if (canal && titulo) {
            return {
                canal: limpar(canal),
                titulo: limpar(titulo)
            };
        }

        return null;
    } catch {
        return null;
    }
}

// ============================================================
// 3º FALLBACK — HTML normal (já existia)
// ============================================================
async function tentarViaHTML(id) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const UA = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
        const resp = await fetch(url, {
            headers: {
                "User-Agent": UA,
                "Accept-Language": "en-US,en;q=0.9",
                "Cookie": fs.existsSync(cookiesPath) ? fs.readFileSync(cookiesPath, "utf8") : ""
            }
        });

        const html = await resp.text();

        if (!html.includes("videoDetails") && !html.includes("ownerChannelName")) {
            return null;
        }

        const { canal, titulo } = extrairTituloECanal_HTML(html);
        if (!canal || !titulo) return null;

        return {
            canal: limpar(canal),
            titulo: limpar(titulo)
        };
    } catch {
        return null;
    }
}

// ============================================================
// JUNTA TUDO — ordem de tentativa
// ============================================================
async function obterInfoVideo(id, arquivo) {
    console.log("🔎 Tentando via noembed...");
    const noembed = await tentarViaNoEmbed(id);
    if (noembed) return noembed;

    console.log("🔎 Tentando via yt-dlp...");
    const ytdlp = tentarViaYtDlp(id);
    if (ytdlp) return ytdlp;

    console.log("🔎 Tentando via HTML direto...");
    const html = await tentarViaHTML(id);
    if (html) return html;

    logErro(`FALHOU TODOS OS MÉTODOS → ${arquivo} | ID ${id}`);
    return null;
}

// ============================================================
// PROCESSAMENTO PRINCIPAL — MANTIDO 100% COMO ESTAVA
// ============================================================

let errosSeguidos = 0;

async function iniciar() {
    console.log("\n🔎 Verificando pasta:", pastaDownloads);

    const arquivos = fs.readdirSync(pastaDownloads)
        .filter(a => a.toLowerCase().endsWith(".mp4"));

    const total = arquivos.length;
    let i = 0;

    console.log(`📦 Total: ${total} vídeos`);

    for (const arquivo of arquivos) {
        i++;
        console.log(`\n(${i}/${total}) 🎞 Processando: ${arquivo}`);

        if (nomeJaTemCanal(arquivo)) {
            console.log("⏭ Já possui nome válido → não requisita.");
            continue;
        }

        const id = extrairID(arquivo);
        if (!id) {
            console.log("⚠️ ID não encontrado.");
            logErro(`ID NÃO ENCONTRADO → ${arquivo}`);
            continue;
        }

        await sleepRandom(2000, 6000);

        console.log("🌐 Buscando informações…");
        const info = await obterInfoVideo(id, arquivo);

        if (!info) {
            console.log("⚠️ Falha total ao obter canal/título.");
            continue;
        }

        const canalLimpo = info.canal;
        const tituloLimpo = info.titulo;

        const matchParte = arquivo.match(/par+te\s?(\d+)/i);
        const parte = matchParte ? ` parte ${matchParte[1]}` : "";

        const novoNome = `${canalLimpo} - ${tituloLimpo} - ${id}${parte}.mp4`;

        console.log("✔️ Renomeado →", novoNome);

        fs.renameSync(
            path.join(pastaDownloads, arquivo),
            path.join(pastaDownloads, novoNome)
        );
    }

    console.log("\n🏁 Finalizado.");
}

iniciar();
