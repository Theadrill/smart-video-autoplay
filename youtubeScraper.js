// youtubeScraper.js
import fetch from "node-fetch";

const SCRAPE_TTL_MS = 15_000; // 15s de cache leve
const scrapeCache = new Map(); // channelUrl -> { ts, videos }

export async function getChannelVideosCached(channelUrl) {
  const now = Date.now();
  const cached = scrapeCache.get(channelUrl);
  if (cached && now - cached.ts < SCRAPE_TTL_MS) {
    // eslint-disable-next-line no-console
    console.log(`🗃️ (SCRAPE CACHE) Reutilizando lista do canal: ${channelUrl}`);
    return cached.videos;
  }
  const videos = await getChannelVideosRobust(channelUrl);
  scrapeCache.set(channelUrl, { ts: now, videos });
  return videos;
}

// Carrega HTML e extrai id/título/data (sem API, sem quota)
export async function getChannelVideos(channelUrl) {
  const url = normalizeToVideosTab(channelUrl);
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  const html = await res.text();

  // Sinalização leve para depuração: página inesperada (consent, etc.)
  if (!/gridVideoRenderer/.test(html)) {
    // eslint-disable-next-line no-console
    console.log("[SCRAPER] Aviso: 'gridVideoRenderer' não encontrado em", url);
  }

  const regex = /"gridVideoRenderer":\{(.*?)\}\}/gs;
  const blocks = [...html.matchAll(regex)];
  const videos = [];

  for (const b of blocks) {
    const block = b[1];
    const id = m(block, /"videoId":"(.*?)"/);
    const title = m(block, /"title":\{"runs":\[\{"text":"(.*?)"\}\]\}/);
    const dateText =
      m(block, /"publishedTimeText":\{"simpleText":"(.*?)"\}/) ||
      m(block, /"publishedTimeText":\{"runs":\[\{"text":"(.*?)"\}\]\}/);

    if (!id || !title || !dateText) continue;

    videos.push({
      id,
      title,
      ageDays: convertDateToDays(dateText),
    });
  }

  // mais novos primeiro
  videos.sort((a, b) => a.ageDays - b.ageDays);
  return videos;
}

// Versão robusta: tenta ytInitialData e faz fallback para regex antiga
export async function getChannelVideosRobust(channelUrl) {
  const url = normalizeToVideosTab(channelUrl);
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  const html = await res.text();

  const hasGrid = /gridVideoRenderer/.test(html);
  const hasInitial = /ytInitialData/.test(html);
  if (!hasGrid && !hasInitial) {
    console.log("[SCRAPER] Aviso: 'ytInitialData' não encontrado em", url);
  } else if (!hasGrid) {
    console.log("[SCRAPER] Aviso: 'gridVideoRenderer' não encontrado (usando ytInitialData)");
  }

  let videos = extractFromInitialData(html);
  if (!videos.length) {
    const regex = /\"gridVideoRenderer\":\{(.*?)\}\}/gs;
    const blocks = [...html.matchAll(regex)];
    for (const b of blocks) {
      const block = b[1];
      const id = m(block, /\"videoId\":\"(.*?)\"/);
      const title = m(block, /\"title\":\{\"runs\":\[\{\"text\":\"(.*?)\"\}\]\}/);
      const dateText =
        m(block, /\"publishedTimeText\":\{\"simpleText\":\"(.*?)\"\}/) ||
        m(block, /\"publishedTimeText\":\{\"runs\":\[\{\"text\":\"(.*?)\"\}\]\}/);
      if (!id || !title) continue;
      videos.push({ id, title, ageDays: convertDateToDays(dateText || "") });
    }
  }

  videos.sort((a, b) => a.ageDays - b.ageDays);
  return videos;
}

function m(str, re) {
  return re.exec(str)?.[1] || null;
}

// Converte “há 3 dias”, “3 weeks ago”, “1 mês atrás” → dias
function convertDateToDays(text) {
  const t = text.toLowerCase();
  const n = parseInt(t.match(/\d+/)?.[0] || "0", 10);

  if (t.includes("minuto") || t.includes("minute")) return 0;
  if (t.includes("hora") || t.includes("hour")) return 0;
  if (t.includes("dia") || t.includes("day")) return n;
  if (t.includes("semana") || t.includes("week")) return n * 7;
  if (t.includes("mês") || t.includes("month")) return n * 30;
  if (t.includes("ano") || t.includes("year")) return n * 365;

  // genéricos “agora”, “just now” → 0
  if (t.includes("agora") || t.includes("just")) return 0;

  return 9999; // fallback = antigo
}

// Extrai chave estável de canal a partir da URL do config (ex: @90minutos)
export function channelKeyFromUrl(url) {
  const at = url.match(/\/(@[^/]+)/);
  if (at) return at[1];
  const ch = url.match(/channel\/([^/]+)/);
  if (ch) return ch[1];
  return url;
}

function normalizeToVideosTab(url) {
  try {
    // já está na aba de vídeos
    if (/\/videos(\/?|$)/.test(url)) return url;
    // handles @nome → force /videos
    if (/\/(@[^/]+)(\/?$)/.test(url)) return url.replace(/\/?$/, "/videos");
    // channel/ID → force /videos
    if (/channel\//.test(url)) return url.replace(/\/?$/, "/videos");
    return url;
  } catch {
    return url;
  }
}

function extractFromInitialData(html) {
  try {
    const idx = html.indexOf("ytInitialData");
    if (idx === -1) return [];
    const start = html.indexOf("{", idx);
    if (start === -1) return [];
    let i = start, depth = 0;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const jsonText = html.slice(start, i);
    const data = JSON.parse(jsonText);

    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const selected = tabs.find(t => t?.tabRenderer?.selected) || tabs[0];
    const root = selected?.tabRenderer?.content || data;

    const out = [];
    walk(root, (node) => {
      const vr = node?.videoRenderer || node?.gridVideoRenderer || node?.playlistVideoRenderer;
      if (vr && vr.videoId) {
        const title = (vr.title?.runs?.[0]?.text) || (vr.title?.simpleText) || '';
        const dateText = (vr.publishedTimeText?.simpleText) || (vr.publishedTimeText?.runs?.[0]?.text) || '';
        out.push({ id: vr.videoId, title, ageDays: convertDateToDays(dateText) });
      }
    });
    return out;
  } catch {
    return [];
  }
}

function walk(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj);
  if (Array.isArray(obj)) { for (const it of obj) walk(it, fn); return; }
  for (const k of Object.keys(obj)) walk(obj[k], fn);
}
