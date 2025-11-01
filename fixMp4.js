import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const DIR = path.resolve("D:/VIDEOS"); // ajuste se necessário

if (!fs.existsSync(DIR)) {
  console.log("❌ Pasta não encontrada:", DIR);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith(".mp4"));

console.log(`\n🎬 Encontrados ${files.length} arquivos para corrigir:`);

for (const f of files) console.log("   •", f);
console.log("\n⚙️ Iniciando correção...\n");

async function fix(file) {
  return new Promise((resolve) => {
    const input = path.join(DIR, file);
    const output = path.join(DIR, file + ".fixed.mp4");

    const ff = spawn("ffmpeg", [
      "-y",
      "-i", input,
      "-c", "copy",
      "-movflags", "+faststart",
      output
    ]);

    ff.on("close", (code) => {
      if (code === 0) {
        fs.unlinkSync(input);
        fs.renameSync(output, input);
      }
      resolve();
    });
  });
}

for (const file of files) {
  await fix(file);
}

console.log("\n✅ Concluído! Arquivos reorganizados.\n");
