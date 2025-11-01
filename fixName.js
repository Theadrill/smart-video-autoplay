import fs from "fs"
import path from "path"

// Lê config
const config = JSON.parse(fs.readFileSync("config.json", "utf8"))

// Resolve pasta correta
const base = path.resolve(config.originalFolderForMergeSplit)

// Primeiro tenta pasta merge-split, se existir
const targetDir = fs.existsSync(path.join(base, "merge-split")) ? path.join(base, "merge-split") : base

console.log(`🎯 Pasta alvo para renomear: ${targetDir}`)

if (!fs.existsSync(targetDir)) {
    console.log("❌ Pasta não encontrada. Nada a fazer.")
    process.exit(0)
}

const files = fs.readdirSync(targetDir)
let renames = 0

for (const file of files) {
    // Detecta padrão "... - finalPartX.mp4"
    const match = file.match(/^(.*) - finalPart(\d+)\.mp4$/i)
    if (!match) continue

    const baseName = match[1].trim()
    const part = Number(match[2])

    const oldPath = path.join(targetDir, file)
    const newPath = path.join(targetDir, `${baseName} parte ${part}.mp4`)

    try {
        fs.renameSync(oldPath, newPath)
        console.log(`🔁 ${file}  →  ${baseName} parte ${part}.mp4`)
        renames++
    } catch (err) {
        console.log(`⚠️ Erro ao renomear: ${file} → ${err.message}`)
    }
}

console.log(`\n✅ Concluído: ${renames} arquivos renomeados.`)
