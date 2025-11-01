async function nextVideo() {
  const res = await fetch("/api/next");
  const data = await res.json();
  if (!data.file) return location.reload();
  const player = document.getElementById("player");
  player.src = `/video/${encodeURIComponent(data.file)}`;
  await player.play().catch(() => {});
}

const player = document.getElementById("player");
player.addEventListener("ended", nextVideo);
player.addEventListener("error", nextVideo);

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") {
    nextVideo();
  }
});

nextVideo();


document.addEventListener("keydown", (e) => {
  // Detecta CTRL + F
  if (e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault(); // Impede abrir a busca
    
    const player = document.getElementById("player");
    if (!player) return;

    // Entra em fullscreen dependendo do navegador
    if (player.requestFullscreen) {
      player.requestFullscreen();
    } else if (player.webkitRequestFullscreen) { // Safari
      player.webkitRequestFullscreen();
    } else if (player.msRequestFullscreen) { // IE / Edge Legacy
      player.msRequestFullscreen();
    }

    console.log("🖥️ Entrando em modo Fullscreen (simulando F11)");
  }
});
