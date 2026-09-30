async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function load() {
  const me = await api("/api/me");
  if (!me.authenticated || me.role !== "streamer") {
    window.location.href = "/auth/twitch?role=streamer";
    return;
  }

  document.getElementById("title").textContent = `@${me.twitchLogin}`;
  document.getElementById("twitch-status").textContent = `Conectado — ${me.twitchDisplayName}`;
  document.getElementById("twitch-status").classList.add("ok");

  const yt = document.getElementById("youtube-status");
  const ytActions = document.getElementById("youtube-actions");
  if (me.youtube.connected) {
    yt.textContent = `Conectado — ${me.youtube.title}`;
    yt.classList.add("ok");
    ytActions.innerHTML = `<button class="btn" data-disconnect="youtube">Desconectar</button>`;
  } else {
    yt.textContent = "Não conectado";
    ytActions.innerHTML = `<a class="btn primary" href="/auth/youtube?intent=streamer">Conectar YouTube</a>`;
  }

  const kick = document.getElementById("kick-status");
  const kickActions = document.getElementById("kick-actions");
  if (me.kick.connected) {
    kick.textContent = `Conectado — ${me.kick.slug}`;
    kick.classList.add("ok");
    kickActions.innerHTML = `
      <a class="btn primary" href="/auth/kick?intent=streamer&reauth=1">Reconectar Kick</a>
      <button class="btn" data-disconnect="kick">Desconectar</button>
      <p class="hint">Reconecte se apagar na Twitch não apagar na Kick (permissão de moderação).</p>
    `;
  } else {
    kick.textContent = "Não conectado";
    kickActions.innerHTML = `<a class="btn primary" href="/auth/kick?intent=streamer">Conectar Kick</a>`;
  }

  const toggle = document.getElementById("relay-toggle");
  toggle.checked = me.relayEnabled;
  document.getElementById("audience-link").textContent = me.audienceLink;

  toggle.onchange = async () => {
    const err = document.getElementById("relay-error");
    err.textContent = "";
    try {
      await api("/api/streamer/relay", {
        method: "POST",
        body: JSON.stringify({ enabled: toggle.checked }),
      });
    } catch (e) {
      toggle.checked = !toggle.checked;
      err.textContent = e.message;
    }
  };

  document.getElementById("copy-link").onclick = async () => {
    await navigator.clipboard.writeText(me.audienceLink);
  };

  const overlayLink = document.getElementById("overlay-link");
  const copyOverlay = document.getElementById("copy-overlay");
  function setOverlayUrl(url) {
    if (url) {
      overlayLink.textContent = url;
      copyOverlay.disabled = false;
    } else {
      overlayLink.textContent = "Gere a URL abaixo";
      copyOverlay.disabled = true;
    }
  }
  setOverlayUrl(me.overlayUrl);

  copyOverlay.onclick = async () => {
    if (me.overlayUrl) await navigator.clipboard.writeText(me.overlayUrl);
  };

  document.getElementById("regen-overlay").onclick = async () => {
    const data = await api("/api/streamer/overlay/token", { method: "POST" });
    me.overlayUrl = data.overlayUrl;
    setOverlayUrl(data.overlayUrl);
    await navigator.clipboard.writeText(data.overlayUrl);
  };

  document.querySelectorAll("[data-disconnect]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/streamer/disconnect/${btn.dataset.disconnect}`, { method: "POST" });
      location.reload();
    });
  });

  document.getElementById("logout").onclick = async () => {
    await api("/auth/logout", { method: "POST" });
    location.href = "/";
  };

  const { logs } = await api("/api/streamer/logs");
  const ul = document.getElementById("logs");
  ul.innerHTML = logs.length
    ? logs
        .map(
          (l) =>
            `<li>[${l.status}] ${l.fromPlatform} → ${l.toPlatform}: ${l.messagePreview ?? ""}</li>`,
        )
        .join("")
    : "<li>Nenhum registro ainda.</li>";
}

load().catch((e) => {
  console.error(e);
  alert(e.message);
});
