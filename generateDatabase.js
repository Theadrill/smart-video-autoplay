import fs from "fs"
import path from "path"

// Lê config.json para pegar o caminho dos vídeos
const config = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"))
const DOWNLOADS_DIR = path.resolve(config.downloadsPath)
const DB_PATH = path.resolve("database.json")

// Analisa nome do arquivo para extrair nome canal, nome vídeo e nome arquivo completo
function parseFileName(fileName) {
    const [canal, ...resto] = fileName.split(" - ")
    return {
        canal: canal ? canal.trim() : "Desconhecido",
        video:
            resto.length > 0
                ? resto
                      .join(" - ")
                      .replace(/\.mp4$/i, "")
                      .trim()
                : "",
        arquivo: fileName,
    }
}

// Função principal para criar ou atualizar o database
function generateDatabase() {
    const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".mp4"))

    // Agrupa vídeos por canal
    const canais = {}

    files.forEach((file) => {
        const { canal, video, arquivo } = parseFileName(file)
        if (!canais[canal]) canais[canal] = []
        canais[canal].push({ video, arquivo })
    })

    // Adiciona IDs sequenciais para vídeos dentro de cada canal
    Object.keys(canais).forEach((canal) => {
        canais[canal] = canais[canal]
            .map((v, i) => ({
                id: i,
                video: v.video,
                arquivo: v.arquivo,
            }))
            .sort((a, b) => a.video.localeCompare(b.video))
    })

    // Lê database existente e checa diferenças
    let existing = {}
    if (fs.existsSync(DB_PATH)) {
        try {
            existing = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"))
        } catch {
            existing = {}
        }
    }

    // Verifica se precisa substituir o arquivo inteiro (quando quantidade ou canais diferentes)
    let rebuild = false
    const existingCount = Object.values(existing).reduce((total, arr) => total + arr.length, 0)
    if (existingCount !== files.length) rebuild = true
    else {
        for (const canal in canais) {
            if (!(canal in existing) || canais[canal].length !== existing[canal].length) {
                rebuild = true
                break
            }
        }
    }

    // Grava no arquivo JSON
    if (rebuild) {
        fs.writeFileSync(DB_PATH, JSON.stringify(canais, null, 2))
        console.log("Database recriada do zero!")
    } else {
        console.log("Database já está atualizada, nenhuma alteração necessária.")
    }
}

generateDatabase()
