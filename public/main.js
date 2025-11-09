// ==========================================================
// 📺 Função: Próximo vídeo
// ==========================================================
let hlsInstance = null

async function nextVideo() {
    const res = await fetch("/api/next")
    const data = await res.json()

    // HUD update (non-intrusive)
    if (window.updateHUD) {
        try { window.updateHUD(data) } catch {}
    }

    const noVideos = document.getElementById("no-videos")
    const player = document.getElementById("player")

    if (!data.file && !data.hls) {
        console.log("⚠️ Nenhum vídeo disponível no servidor.")
        noVideos.classList.add("visible")
        player.src = "" // garante que pare o vídeo atual caso exista
        return
    }

    noVideos.classList.remove("visible")

    if (data.hls && data.id) {
        await playHls(data.hls)
    } else if (data.file) {
        await playFile(`/video/${encodeURIComponent(data.file)}`)
    }
}

async function playFile(src){
    const player = document.getElementById("player")
    // cleanup HLS se existir
    if (hlsInstance) { try { hlsInstance.destroy() } catch{} hlsInstance = null }
    player.src = src
    player.muted = true
    await player.play().catch(()=>{ console.log("⚠️ player.play() (file) falhou.") })
}

async function playHls(m3u8){
    const player = document.getElementById("player")
    // cleanup anterior
    if (hlsInstance) { try { hlsInstance.destroy() } catch{} hlsInstance = null }

    // Safari / nativo HLS
    if (player.canPlayType('application/vnd.apple.mpegurl')){
        player.src = m3u8
        player.muted = true
        await player.play().catch(()=>{ console.log("⚠️ player.play() (native HLS) falhou.") })
        return
    }

    if (window.Hls && window.Hls.isSupported()){
        hlsInstance = new window.Hls({
            lowLatencyMode: false,
            backBufferLength: 30,
            maxLiveSyncPlaybackRate: 1.5,
        })
        hlsInstance.on(window.Hls.Events.ERROR, (evt, data) => {
            if (data?.fatal) {
                console.log("⚠️ HLS fatal:", data)
                try { hlsInstance.destroy() } catch{}
                hlsInstance = null
                // pequena re-tentativa após 1s
                setTimeout(()=>playHls(m3u8), 1000)
            }
        })
        hlsInstance.loadSource(m3u8)
        hlsInstance.attachMedia(player)
        player.muted = true
        await player.play().catch(()=>{ console.log("⚠️ player.play() (hls.js) falhou.") })
        return
    }

    // Fallback: tentar tocar direto mesmo sem suporte
    await playFile(m3u8)
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

// ==========================================================
// Dev HUD (toggle with 'H')
// ==========================================================
;(function setupDevHUD(){
    const hud = document.createElement('div')
    hud.id = 'dev-hud'
    hud.style.cssText = [
        'position:fixed',
        'top:8px','left:8px','max-width:40vw',
        'background:rgba(0,0,0,0.6)','color:#fff','padding:8px 10px',
        'font:12px/1.4 monospace','z-index:9999','border-radius:4px',
        'display:none','white-space:pre-line','user-select:none'
    ].join(';')
    document.body.appendChild(hud)

    let hudVisible = false
    function setHUDVisible(v){ hudVisible = !!v; hud.style.display = hudVisible ? 'block' : 'none' }

    document.addEventListener('keydown', (e)=>{
        const k = (e.key||'').toLowerCase()
        if (k === 'h') setHUDVisible(!hudVisible)
    })

    function parseLocalFilename(file){
        try{
            let base = file.replace(/\.mp4$/i,'')
            base = base.replace(/\s+parte\s+\d+$/i,'')
            const parts = base.split(' - ')
            if (parts.length >= 3){
                const channel = parts[0].trim()
                const id = parts[parts.length-1].trim()
                const title = parts.slice(1, parts.length-1).join(' - ').trim()
                return {channel,title,id}
            }
            return {channel:'', title: base, id: ''}
        }catch{ return {channel:'',title:'',id:''} }
    }

    async function fillYouTubeMeta(id){
        try{
            const r = await fetch(`/api/info/${encodeURIComponent(id)}`)
            if (!r.ok) return {channel:'', title:''}
            const j = await r.json()
            return { channel: j.channel||'', title: j.title||'' }
        }catch{ return {channel:'', title:''} }
    }

    function renderHUD({mode, channel, title, id, nextHint}){
        const lines = [
            `MODE: ${mode || ''}`,
            `CHANNEL: ${channel || ''}`,
            `TITLE: ${title || ''}`,
            `ID: ${id || ''}`,
            `NEXT: ${nextHint || ''}`,
        ]
        hud.textContent = lines.join('\n')
    }

    async function _updateHUD(info){
        if (!info){ renderHUD({mode:'',channel:'',title:'',id:'',nextHint:''}); return }
        let mode = (info && info.hls && info.id) ? 'YOUTUBE' : (info && info.file) ? 'LOCAL' : 'UNKNOWN'
        let channel = '', title = '', id = ''
        if (mode === 'LOCAL'){
            const meta = parseLocalFilename(info.file)
            channel = meta.channel; title = meta.title; id = meta.id
        } else if (mode === 'YOUTUBE'){
            id = info.id
            const meta = await fillYouTubeMeta(id)
            channel = meta.channel; title = meta.title
        }
        renderHUD({mode, channel, title, id, nextHint: ''})
    }

    window.updateHUD = (info) => { _updateHUD(info) }
})()
