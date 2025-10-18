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
