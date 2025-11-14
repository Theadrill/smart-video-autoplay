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
    console.log(`\n🔎 Coletando vídeos de: ${url}`);

    const result = spawnSync("yt-dlp", [
        "--dump-json",
        "--flat-playlist",
        url
    ], { encoding: "utf-8" });

    if (!result.stdout.trim()) {
        console.log("⚠️ Nenhum vídeo encontrado.");
        return [];
    }

    const lines = result.stdout.trim().split("\n");
    const videos = [];

    for (const line of lines) {
        try {
            const data = JSON.parse(line);

            if (!data.id) continue;

            videos.push({
                id: data.id,
                title: sanitize(data.title || ""),
                uploader: sanitize(data.uploader || data.channel || "Canal"),
                duration: data.duration || null,
                url: `https://www.youtube.com/watch?v=${data.id}`
            });
        } catch (err) {
            console.log("⚠️ JSON inválido do yt-dlp:", err);
        }
    }

    return videos;
}

function applyFilters(videos) {
    return videos.filter(v => {

        // ignorar shorts
        if (IGNORE_SHORTS && v.duration && v.duration < 60) return false;

        // ignorar duração mínima
        if (v.duration && v.duration < MIN_DURATION) return false;

        const titleLower = v.title.toLowerCase();

        // exclui palavras proibidas
        if (EXCLUDE.some(k => titleLower.includes(k.toLowerCase()))) return false;

        // inclui palavras obrigatórias (se existir pelo menos 1 include)
        if (INCLUDE.length > 0) {
            if (!INCLUDE.some(k => titleLower.includes(k.toLowerCase()))) return false;
        }

        return true;
    });
}

function groupByChannel(videos) {
    const grouped = {};
    for (const v of videos) {
        if (!grouped[v.uploader]) grouped[v.uploader] = [];
        grouped[v.uploader].push(v);
    }
    return grouped;
}

// ==========================================================
// PROCESSO PRINCIPAL
// ==========================================================
(async () => {

    let allVideos = [];

    for (const url of URLS) {
        const vids = fetchVideosFromUrl(url);
        allVideos.push(...vids);
    }

    console.log(`\n📦 Total bruto coletado: ${allVideos.length}`);

    allVideos = applyFilters(allVideos);

    console.log(`📌 Após filtros: ${allVideos.length}`);

    const grouped = groupByChannel(allVideos);

    const downloadsPath = Array.isArray(config.downloadsPath)
        ? config.downloadsPath[0]
        : config.downloadsPath;

    const cacheFile = path.join(path.resolve(downloadsPath), "videos_cache.json");

    fs.writeFileSync(cacheFile, JSON.stringify(grouped, null, 2));

    console.log(`\n💾 videos_cache.json gerado com sucesso em:`);
    console.log(cacheFile);
})();
