import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd) {
    return new Promise((resolve) => {
        console.log("\n>> Executando:", cmd);
        exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
            if (err) console.error(stderr || err);
            else console.log(stdout);
            resolve();
        });
    });
}

async function main() {
    console.log("🔄 Iniciando atualização do repositório...");

    // 1. Git pull
    console.log("\n📥 Atualizando código via git pull...");
    await run("git pull");

    // 2. Atualizar dependências
    console.log("\n📦 Instalando dependências...");
    await run("npm install");
    // ou, se preferir:
    // await run("npm update");

    console.log("\n✔ Atualização finalizada!");

    // 3. Contagem para fechar
    let seconds = 5;
    let interval = setInterval(() => {
        process.stdout.write(`Fechando em ${seconds}...\r`);
        seconds--;
        if (seconds < 0) {
            clearInterval(interval);
            process.exit(0);
        }
    }, 1000);
}

main();
