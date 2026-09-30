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

function setStatus(id, text, ok = false) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

async function load() {
  const params = new URLSearchParams(location.search);
  const streamerLogin = params.get("streamer");
  if (streamerLogin) {
    try {
      const s = await api(`/api/streamer/by-login/${encodeURIComponent(streamerLogin)}`);
      document.getElementById("streamer-hint").textContent =
        `Vinculando para o canal de ${s.twitchDisplayName} (@${s.twitchLogin}). Mensagens no YouTube/Kick aparecerão na Twitch como o seu @Twitch.`;
    } catch {
      /* ignore */
    }
  }

  const me = await api("/api/me");
  const twitchActions = document.getElementById("twitch-actions");
  const logout = document.getElementById("logout");

  if (!me.authenticated || me.role !== "viewer") {
    setStatus("twitch-status", "Pendente");
    twitchActions.innerHTML = `<a class="btn primary" href="/auth/twitch?role=viewer">Entrar com Twitch</a>`;
    setStatus("youtube-status", "Faça login na Twitch primeiro");
    setStatus("kick-status", "Faça login na Twitch primeiro");
    return;
  }

  logout.hidden = false;
  logout.onclick = async () => {
    await api("/auth/logout", { method: "POST" });
    location.href = "/";
  };

  setStatus("twitch-status", `Conectado — @${me.twitchLogin}`, true);
  twitchActions.innerHTML = "";

  const yt = me.identities.find((i) => i.platform === "youtube");
  const kick = me.identities.find((i) => i.platform === "kick");
  const ytActions = document.getElementById("youtube-actions");
  const kickActions = document.getElementById("kick-actions");

  if (yt) {
    setStatus("youtube-status", `Vinculado — ${yt.platformDisplayName || yt.platformUserId}`, true);
    ytActions.innerHTML = `<button class="btn" data-unlink="youtube">Desvincular</button>`;
  } else {
    setStatus("youtube-status", "Pendente");
    ytActions.innerHTML = `<a class="btn primary" href="/auth/youtube?intent=viewer">Vincular YouTube</a>`;
  }

  if (kick) {
    setStatus("kick-status", `Vinculado — ${kick.platformDisplayName || kick.platformUserId}`, true);
    kickActions.innerHTML = `<button class="btn" data-unlink="kick">Desvincular</button>`;
  } else {
    setStatus("kick-status", "Pendente");
    kickActions.innerHTML = `<a class="btn primary" href="/auth/kick?intent=viewer">Vincular Kick</a>`;
  }

  document.querySelectorAll("[data-unlink]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/viewer/unlink/${btn.dataset.unlink}`, { method: "POST" });
      location.reload();
    });
  });

  if (yt || kick) {
    const confirm = document.getElementById("confirm");
    confirm.hidden = false;
    confirm.textContent = `Contas vinculadas. Suas mensagens no YouTube/Kick aparecerão na Twitch como @${me.twitchLogin}.`;
  }
}

load().catch(console.error);
