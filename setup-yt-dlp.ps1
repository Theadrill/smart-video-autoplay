# ========================
#  Setup automático yt-dlp
# ========================

Write-Host "Iniciando setup do yt-dlp com suporte EJS..."

# Caminho do config do yt-dlp no Windows
$ConfigDir = "$env:APPDATA\yt-dlp"
$ConfigFile = "$ConfigDir\config.txt"

# -------------------------------------------
# 1. Instalar Deno caso não exista
# -------------------------------------------
if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    Write-Host "Deno não encontrado. Instalando..."

    $installer = "$env:TEMP\deno-install.ps1"
    Invoke-WebRequest "https://deno.land/install.ps1" -OutFile $installer

    powershell -ExecutionPolicy Bypass -File $installer

    Write-Host "Deno instalado."
} else {
    Write-Host "Deno encontrado. Versão:"
    deno --version
}

# -------------------------------------------
# 2. Conferir yt-dlp instalado
# -------------------------------------------
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
    Write-Host "ERRO: yt-dlp não está instalado. Instale primeiro."
    exit
} else {
    Write-Host "yt-dlp versão:" (yt-dlp --version)
}

# -------------------------------------------
# 3. Instalar yt-dlp-ejs e dependências via pip
# -------------------------------------------
Write-Host "Instalando/atualizando módulos yt-dlp e yt-dlp-ejs..."

python -m pip install --upgrade "yt-dlp[default]"
python -m pip install --upgrade yt-dlp-ejs

# -------------------------------------------
# 4. Criar config do yt-dlp
# -------------------------------------------
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir | Out-Null
}

# Criar arquivo config.txt usando Add-Content para evitar erros de parse
" --cookies cookies.txt" | Out-File -FilePath $ConfigFile -Encoding ASCII
" --extractor-args youtube:player_client=web,ejs=True" | Add-Content -Path $ConfigFile
" --remote-components ejs:github" | Add-Content -Path $ConfigFile
" --js-runtimes deno" | Add-Content -Path $ConfigFile

Write-Host "Configuração escrita em:"
Write-Host "   $ConfigFile"

# -------------------------------------------
# 5. Teste rápido
# -------------------------------------------
Write-Host "Testando EJS rapidamente..."

$test = yt-dlp --dump-json "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1

if ($test -match "n challenge" -or $test -match "EJS" -or $test -match "solver") {
    Write-Host "ATENÇÃO: o solver EJS ainda pode não estar funcionando."
} else {
    Write-Host "EJS ativo com sucesso!"
}

Write-Host "Setup concluído."
