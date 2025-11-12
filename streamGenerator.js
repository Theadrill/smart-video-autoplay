// streamGenerator.js
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export function ensureHLSCache(inputPath, streamRoot, base) {
  const folder = path.join(streamRoot, base);
  const targetM3U8 = path.join(folder, `${base}.m3u8`);

  if (fs.existsSync(targetM3U8)) return targetM3U8;

  fs.mkdirSync(folder, { recursive: true });

  execSync(
    `ffmpeg -i "${inputPath}" -c copy -start_number 0 -hls_time 6 -hls_list_size 0 -hls_segment_filename "${folder}/${base}_%03d.ts" "${targetM3U8}"`,
    { stdio: "inherit" }
  );

  pruneStreamCache(streamRoot, 2);
  return targetM3U8;
}

function pruneStreamCache(root, maxFolders) {
  const subdirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (subdirs.length <= maxFolders) return;
  for (const dir of subdirs.slice(maxFolders)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
