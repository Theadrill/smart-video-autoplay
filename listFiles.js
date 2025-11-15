import fs from "fs";
import path from "path";

// ==================================
// 🔧 LÊ O CONFIG.JSON
// ==================================
const configPath = path.resolve("config.json");

if (!fs.existsSync(configPath)) {
    console.error("❌ ERRO: config.json não encontrado!");
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Aceita string OU array
const downloadsPaths = Array.isArray(config.downloadsPath)
    ? config.downloadsPath.map((p) => path.resolve(p))
    : [path.resolve(config.downloadsPath)];

const outputFile = "lista.txt";

let resultado = [];

console.log("\n📂 Pastas configuradas:");
downloadsPaths.forEach((p) => console.log("   →", p));

// ==================================
// 📁 FUNÇÃO PARA LISTAR ARQUIVOS
// ==================================
function listarArquivos(dir) {
    try {
        const itens = fs.readdirSync(dir, { withFileTypes: true });

        for (const item of itens) {
            const itemPath = path.join(dir, item.name);

            if (item.isFile()) {
                resultado.push(`FILE: ${item.name} | PATH: ${itemPath}`);
            } else if (item.isDirectory()) {
                resultado.push(`DIR:  ${item.name} | PATH: ${itemPath}`);
            }
        }
    } catch (err) {
        resultado.push(`❌ ERRO lendo ${dir}: ${err.message}`);
    }
}

// ==================================
// ▶️ EXECUTA LISTAGEM NAS PASTAS
// ==================================
for (const pasta of downloadsPaths) {
    listarArquivos(pasta);
}

// ==================================
// 📝 SALVA NO TXT
// ==================================
fs.writeFileSync(outputFile, resultado.join("\n"), "utf8");

console.log(`\n✅ Lista salva em: ${outputFile}`);
console.log(`📄 Total de itens listados: ${resultado.length}\n`);
