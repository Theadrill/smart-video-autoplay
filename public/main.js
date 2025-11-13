// ==========================================================
// 📺 Função: Próximo vídeo
// ==========================================================
async function nextVideo() {
    const res = await fetch("/api/next")
    const data = await res.json()

    const noVideos = document.getElementById("no-videos")
    const player = document.getElementById("player")

    if (!data.file) {
        console.log("⚠️ Nenhum vídeo disponível no servidor.")
        noVideos.classList.add("visible")
        player.src = ""
        return
    }

    noVideos.classList.remove("visible")

    player.src = `/video/${encodeURIComponent(data.file)}`
    player.muted = true

    await player.play().catch(() => {
        console.log("⚠️ player.play() falhou, tentando novamente.")
    })
}

// ==========================================================
// ⏪ Função: Vídeo anterior
// ==========================================================
async function previousVideo() {
    const res = await fetch("/api/previous")
    const data = await res.json()

    if (!data.file) {
        console.log("⛔ Não há vídeo anterior.")
        return
    }

    const player = document.getElementById("player")
    player.src = `/video/${encodeURIComponent(data.file)}`

    await player.play().catch(() => {
        console.log("⚠️ player.play() falhou ao voltar.")
    })
}

// ==========================================================
// 🎬 Eventos automáticos
// ==========================================================
const player = document.getElementById("player")
player.addEventListener("ended", nextVideo)
player.addEventListener("error", nextVideo)

// ==========================================================
// ▶️ Iniciar reprodução
// ==========================================================
nextVideo()

// ==========================================================
// 🖥️ Fullscreen
// ==========================================================
const container = document.getElementById("player-container")

function enterFullscreen() {
    if (!document.fullscreenElement) {
        if (container.requestFullscreen) container.requestFullscreen()
        else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen()
        console.log("🖥️ Fullscreen ativado")
        return true
    }
    return false
}

// ==========================================================
// 👆 Controles por clique (esquerda / direita)
// ==========================================================
document.getElementById("click-left").addEventListener("click", () => {
    if (enterFullscreen()) return
    previousVideo()
})

document.getElementById("click-right").addEventListener("click", () => {
    if (enterFullscreen()) return
    nextVideo()
})

// ==========================================================
// 📊 Barra de Progresso
// ==========================================================
const progress = document.getElementById("progress")
const progressFill = progress.querySelector(".fill")

player.addEventListener("timeupdate", () => {
    if (!player.duration) return
    progressFill.style.width = (player.currentTime / player.duration) * 100 + "%"
})

function seekAt(clientX) {
    const r = progress.getBoundingClientRect()
    const pct = (clientX - r.left) / r.width
    if (player.duration) player.currentTime = pct * player.duration
}

progress.addEventListener("click", (e) => seekAt(e.clientX), { passive: true })
progress.addEventListener("touchstart", (e) => seekAt(e.touches[0].clientX), { passive: true })

// ==========================================================
// 🖱 Cursor desaparece após inatividade
// ==========================================================
let cursorTimeout = null

function scheduleCursorHide() {
    document.body.classList.remove("hide-cursor")
    if (cursorTimeout) clearTimeout(cursorTimeout)
    cursorTimeout = setTimeout(() => {
        document.body.classList.add("hide-cursor")
    }, 1500)
}

container.addEventListener("mousemove", scheduleCursorHide, { passive: true })
container.addEventListener("touchstart", scheduleCursorHide, { passive: true })
document.addEventListener("fullscreenchange", scheduleCursorHide)

// ==========================================================
// 🎛 HUD DE CONTROLES
// ==========================================================
const hudControls = document.getElementById('hud-controls')
const btnRewind = document.getElementById('btn-rewind')
const btnPlayPause = document.getElementById('btn-play-pause')
const btnNext = document.getElementById('btn-next')

let hudTimeout = null
let isHudVisible = false

// Mostrar/ocultar HUD (controla barra também)
function showHud() {
    if (isHudVisible) return
    
    hudControls.classList.add('visible')
    progress.classList.add('visible') // Barra aparece com a HUD
    isHudVisible = true
    scheduleHudHide()
    scheduleCursorHide()
}

function hideHud() {
    hudControls.classList.remove('visible')
    progress.classList.remove('visible') // Barra some com a HUD
    isHudVisible = false
}

function scheduleHudHide() {
    clearTimeout(hudTimeout)
    hudTimeout = setTimeout(hideHud, 3000)
}

// Alternar play/pause
function togglePlayPause() {
    if (player.paused) {
        player.play()
        btnPlayPause.classList.add('playing')
    } else {
        player.pause()
        btnPlayPause.classList.remove('playing')
    }
    showHud()
}

// Voltar ao início
function rewindToStart() {
    player.currentTime = 0
    showHud()
}

// Event listeners dos botões
btnRewind.addEventListener('click', rewindToStart)
btnPlayPause.addEventListener('click', togglePlayPause)
btnNext.addEventListener('click', () => {
    nextVideo()
    showHud()
})

// Atualizar ícone do play/pause baseado no estado do vídeo
player.addEventListener('play', () => {
    btnPlayPause.classList.add('playing')
})

player.addEventListener('pause', () => {
    btnPlayPause.classList.remove('playing')
})

// Mostrar HUD ao tocar na tela (áreas não clicáveis)
container.addEventListener('click', (e) => {
    if (!e.target.closest('#click-left') && 
        !e.target.closest('#click-right')) {
        showHud()
    }
})

// Mostrar HUD também ao mover mouse/tocar
container.addEventListener('mousemove', showHud, { passive: true })
container.addEventListener('touchmove', showHud, { passive: true })

// Esconder HUD quando vídeo terminar
player.addEventListener('ended', () => {
    hideHud()
})

// Inicializar ícone correto
if (!player.paused) {
    btnPlayPause.classList.add('playing')
}

// Cancelar hide da HUD quando interagir com controles
hudControls.addEventListener('mousemove', (e) => {
    e.stopPropagation()
    scheduleHudHide()
})

hudControls.addEventListener('touchmove', (e) => {
    e.stopPropagation()
    scheduleHudHide()
})

// Cancelar hide da HUD quando interagir com a barra
progress.addEventListener('mousemove', (e) => {
    e.stopPropagation()
    scheduleHudHide()
})

progress.addEventListener('touchmove', (e) => {
    e.stopPropagation()
    scheduleHudHide()
})