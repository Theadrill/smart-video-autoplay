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
        player.src = "" // garante que pare o vídeo atual caso exista
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

function showProgressBar() {
    progress.classList.add("visible")
    scheduleCursorHide()
}

function seekAt(clientX) {
    const r = progress.getBoundingClientRect()
    const pct = (clientX - r.left) / r.width
    if (player.duration) player.currentTime = pct * player.duration
    showProgressBar()
}

progress.addEventListener("click", (e) => seekAt(e.clientX), { passive: true })
progress.addEventListener("touchstart", (e) => seekAt(e.touches[0].clientX), { passive: true })

let hideProgressTimeout = null

function showProgressBar() {
    progress.classList.add("visible")

    // Se estava sendo escondida, cancela
    if (hideProgressTimeout) clearTimeout(hideProgressTimeout)

    // Agenda esconder
    hideProgressTimeout = setTimeout(() => {
        progress.classList.remove("visible")
    }, 1500)

    // Também mostra cursor e agenda esconder cursor
    scheduleCursorHide()
}

container.addEventListener("mousemove", showProgressBar, { passive: true })
container.addEventListener("touchmove", showProgressBar, { passive: true })

// ==========================================================
// 🖱 Cursor desaparece após inatividade + durante seek
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

// Durante clique na barra → cursor some imediatamente
progress.addEventListener("mousedown", () => document.body.classList.add("hide-cursor"))
progress.addEventListener("mouseup", scheduleCursorHide)
