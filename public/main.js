// Player + Reconexão + Autoplay
let hlsInstance = null
let awaitingFirstFrame = false
let reconnecting = false
let reconnectTimer = null
let stallTimer = null

function setLoaderVisible(v){
  const el = document.getElementById('loader')
  if (!el) return
  if (v) el.classList.add('visible')
  else el.classList.remove('visible')
}

function setLoaderTitle(text){
  const t = document.getElementById('loader-title')
  if (!t) return
  t.textContent = text ? String(text) : ''
}

function clearStallTimer(){ if (stallTimer){ clearTimeout(stallTimer); stallTimer=null } }

async function healthOk(){ try{ const r = await fetch('/health', { cache:'no-store' }); return r.ok } catch { return false } }

function onBufferingStart(){
  setLoaderVisible(true)
  setLoaderTitle('')
  clearStallTimer()
  stallTimer = setTimeout(async ()=>{ if (!(await healthOk())) startReconnect() }, 2500)
}

function startReconnect(){
  if (reconnecting) return
  reconnecting = true
  setLoaderVisible(true)
  setLoaderTitle('Reconectando…')
  const ping = async ()=>{
    if (await healthOk()){
      if (reconnectTimer){ clearInterval(reconnectTimer); reconnectTimer=null }
      reconnecting = false
      setLoaderTitle('')
      await nextVideo()
    }
  }
  ping()
  reconnectTimer = setInterval(ping, 1500)
  window.addEventListener('online', ping, { once:true })
}

async function nextVideo(){
  setLoaderVisible(true)
  setLoaderTitle('')

  let data = null
  try{
    const res = await fetch('/api/next', { cache:'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  }catch(e){
    console.log('[RECONNECT] /api/next falhou:', e?.message||e)
    startReconnect()
    return
  }

  if (window.updateHUD) { try { window.updateHUD(data) } catch{} }

  const noVideos = document.getElementById('no-videos')
  const player = document.getElementById('player')

  if (!data || (!data.file && !data.hls)){
    setLoaderVisible(false)
    if (noVideos) noVideos.classList.add('visible')
    if (player) player.src = ''
    return
  } else {
    if (noVideos) noVideos.classList.remove('visible')
  }

  if (data && data.title) setLoaderTitle(data.title)

  if (data.hls && data.id) await playHls(data.hls)
  else if (data.file) await playFile(`/video/${encodeURIComponent(data.file)}`)
}

async function playFile(src){
  const player = document.getElementById('player')
  if (!player) return
  if (hlsInstance) { try { hlsInstance.destroy() } catch{}; hlsInstance=null }
  player.src = src
  player.muted = true
  awaitingFirstFrame = true
  await player.play().catch(e => console.log('[player] play() (file) falhou', e))
}

async function playHls(m3u8){
  const player = document.getElementById('player')
  if (!player) return
  if (hlsInstance) { try { hlsInstance.destroy() } catch{}; hlsInstance=null }

  if (player.canPlayType('application/vnd.apple.mpegurl')){
    player.src = m3u8
    player.muted = true
    awaitingFirstFrame = true
    await player.play().catch(()=> console.log('[player] play() (native HLS) falhou'))
    return
  }

  if (window.Hls && window.Hls.isSupported()){
    hlsInstance = new window.Hls({ lowLatencyMode:false, backBufferLength:30, maxLiveSyncPlaybackRate:1.5 })
    hlsInstance.on(window.Hls.Events.ERROR, (evt, data)=>{
      if (data?.fatal){ try { hlsInstance.destroy() } catch{}; hlsInstance=null; startReconnect() }
    })
    hlsInstance.loadSource(m3u8)
    hlsInstance.attachMedia(player)
    player.muted = true
    awaitingFirstFrame = true
    await player.play().catch(()=> console.log('[player] play() (hls.js) falhou'))
    return
  }

  await playFile(m3u8)
}

// ===== Global player events & UI =====
const player = document.getElementById('player')
player.addEventListener('loadeddata', ()=>{ clearStallTimer(); setLoaderVisible(false) })
player.addEventListener('canplay',    ()=>{ clearStallTimer(); setLoaderVisible(false) })
player.addEventListener('playing',    ()=>{ clearStallTimer(); setLoaderVisible(false) })
player.addEventListener('waiting', onBufferingStart)
player.addEventListener('stalled', onBufferingStart)
player.addEventListener('timeupdate', () => {
    if (awaitingFirstFrame && !player.paused && player.currentTime > 0.05) {
        clearStallTimer()
        setLoaderVisible(false)
        awaitingFirstFrame = false
    }
    if (player.duration) {
        const progressPercent = (player.currentTime / player.duration) * 100
        progressFill.style.width = `${progressPercent}%`
    }
})
player.addEventListener('ended', nextVideo)
player.addEventListener('error', nextVideo)

setLoaderVisible(true); setLoaderTitle(''); nextVideo()

// Fullscreen & click zones
const container = document.getElementById('player-container')
function enterFullscreen(){ if (!document.fullscreenElement){ if (container.requestFullscreen) container.requestFullscreen(); else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen(); return true } return false }

// Overlay: apenas entra em fullscreen (sem navegação)
const leftZone = document.getElementById('click-left')
const rightZone = document.getElementById('click-right')
leftZone.addEventListener('click', ()=>{ enterFullscreen(); updateControlsVisibility() })
rightZone.addEventListener('click', ()=>{ enterFullscreen(); updateControlsVisibility() })
leftZone.addEventListener('touchstart', (e)=>{ e.preventDefault(); enterFullscreen(); updateControlsVisibility() }, { passive:false })
rightZone.addEventListener('touchstart', (e)=>{ e.preventDefault(); enterFullscreen(); updateControlsVisibility() }, { passive:false })

// Controles visíveis
const controls = document.getElementById('controls')
const btnPrev = document.getElementById('btn-prev')
const btnPlay = document.getElementById('btn-play')
const btnNext = document.getElementById('btn-next')

let controlsHideTimer = null
function hideControls() {
    if (!controls) return
    controls.style.display = 'none'
    controls.setAttribute('aria-hidden', 'true')
}
function showControls() {
    if (!controls) return
    controls.style.display = 'flex'
    controls.setAttribute('aria-hidden', 'false')
    if (controlsHideTimer) clearTimeout(controlsHideTimer)
    controlsHideTimer = setTimeout(hideControls, 2000)
}
function updateControlsVisibility() {
    showControls()
}
document.addEventListener('fullscreenchange', updateControlsVisibility)
updateControlsVisibility()
container.addEventListener('mousemove', showControls, { passive: true })
container.addEventListener('touchstart', showControls, { passive: true })

// Atualiza ícone do play conforme estado atual
try {
    const p0 = document.getElementById('player')
    if (btnPlay && p0) btnPlay.textContent = p0.paused ? '▶️' : '⏸️'
} catch {}

player.addEventListener('play', () => {
    if (btnPlay) btnPlay.textContent = '⏸️'
})
player.addEventListener('pause', () => {
    if (btnPlay) btnPlay.textContent = '▶️'
})

btnPrev?.addEventListener('click', async () => {
    const p = document.getElementById('player')
    if (p && p.currentTime > 5) {
        try {
            p.currentTime = 0
        } catch {}
        if (typeof showProgressBar === 'function') showProgressBar()
    } else {
        await previousVideo()
    }
})
btnNext?.addEventListener('click', () => {
    try {
        setLoaderVisible(true)
        setLoaderTitle('Carregando proximo video')
    } catch {}
    nextVideo()
})
btnPlay?.addEventListener('click', () => {
    const p = document.getElementById('player')
    if (!p) return
    try {
        if (p.paused) {
            p.play().catch(() => {})
            if (btnPlay) btnPlay.textContent = '⏸️'
        } else {
            p.pause()
            if (btnPlay) btnPlay.textContent = '▶️'
        }
    } catch {}
})

// ===== Barra de Progresso =====
const progress = document.getElementById('progress')
const progressFill = progress.querySelector('.fill')

function seekAt(e) {
    const progressRect = progress.getBoundingClientRect()
    const seekTime =
        ((e.clientX - progressRect.left) / progressRect.width) *
        player.duration
    player.currentTime = seekTime
}

progress.addEventListener('click', seekAt)

let hideProgressTimeout = null
function showProgressBar() {
    progress.classList.add('visible')
    if (hideProgressTimeout) clearTimeout(hideProgressTimeout)
    hideProgressTimeout = setTimeout(() => {
        progress.classList.remove('visible')
    }, 1500)
    scheduleCursorHide()
}

// ===== Cursor auto-hide =====
let cursorTimeout=null
function scheduleCursorHide(){ document.body.classList.remove('hide-cursor'); if (cursorTimeout) clearTimeout(cursorTimeout); cursorTimeout=setTimeout(()=>{ document.body.classList.add('hide-cursor') }, 1500) }
container.addEventListener('mousemove', ()=>{ showProgressBar(); scheduleCursorHide() }, { passive:true })
    container.addEventListener('touchstart', ()=>{ showProgressBar(); scheduleCursorHide() }, { passive:true })
    container.addEventListener('touchmove',  ()=>{ showProgressBar(); scheduleCursorHide() }, { passive:true })
document.addEventListener('fullscreenchange', scheduleCursorHide)

// previousVideo endpoint
async function previousVideo(){
  try{
    const r = await fetch('/api/previous', { cache:'no-store' });
    const j = await r.json();
    const p = document.getElementById('player');
    if (!p) return;
    if (!j.file){
      try { p.currentTime = 0 } catch {}
      try { setLoaderTitle('') } catch{}
      try { setLoaderVisible(false) } catch{}
      return;
    }
    if (hlsInstance) { try { hlsInstance.destroy() } catch{}; hlsInstance=null }
    if (hlsInstance) { try { hlsInstance.destroy() } catch{}; hlsInstance=null }
    try { setLoaderVisible(true); setLoaderTitle('Carregando video anterior') } catch{}
    p.src = `/video/${encodeURIComponent(j.file)}`;
    await p.play().catch(()=>{})
    awaitingFirstFrame=true; await p.play().catch(()=>{})
    try { setLoaderVisible(false) } catch{}
  } catch{}
}

// Dev HUD (toggle with 'H') — opcional
;(function setupDevHUD(){
  const hud = document.createElement('div'); hud.id='dev-hud'; hud.style.cssText=['position:fixed','top:8px','left:8px','max-width:40vw','background:rgba(0,0,0,0.6)','color:#fff','padding:8px 10px','font:12px/1.4 monospace','z-index:9999','border-radius:4px','display:none','white-space:pre-line','user-select:none'].join(';'); document.body.appendChild(hud)
  let hudVisible=false; function setHUD(v){ hudVisible=!!v; hud.style.display=hudVisible?'block':'none' }
  document.addEventListener('keydown',(e)=>{ if ((e.key||'').toLowerCase()==='h') setHUD(!hudVisible) })
  function renderHUD({mode,channel,title,id,nextHint}){ document.getElementById('dev-hud').textContent=[`MODE: ${mode||''}`,`CHANNEL: ${channel||''}`,`TITLE: ${title||''}`,`ID: ${id||''}`,`NEXT: ${nextHint||''}`].join('\n') }
  async function _updateHUD(info){ if (!info){ renderHUD({mode:'',channel:'',title:'',id:'',nextHint:''}); return } let mode=(info&&info.hls&&info.id)?'YOUTUBE':(info&&info.file)?'LOCAL':'UNKNOWN'; let channel='',title='',id=''; if (mode==='LOCAL'){ const base=(info.file||'').replace(/\.mp4$/i,'').replace(/\s+parte\s+\d+$/i,''); const parts=base.split(' - '); if (parts.length>=3){ channel=parts[0].trim(); id=parts[parts.length-1].trim(); title=parts.slice(1,parts.length-1).join(' - ').trim() } else { title=base } } else if (mode==='YOUTUBE'){ id=info.id; try{ const r=await fetch(`/api/info/${encodeURIComponent(id)}`); if (r.ok){ const j=await r.json(); channel=j.channel||''; title=j.title||'' } }catch{} } renderHUD({mode,channel,title,id,nextHint:''}) }
  window.updateHUD = (info)=>{ _updateHUD(info) }
})()

















