const MAX_MESSAGES = 80;

const params = new URLSearchParams(location.search);
const token = params.get("token");
const feed = document.getElementById("feed");
const statusEl = document.getElementById("status");

const PLATFORM_ICON = {
  twitch: "/icons/twitch.png",
  youtube: "/icons/youtube.png",
  kick: "/icons/kick.png",
};

const PLATFORM_LABEL = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
};

function showStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

function removeMessage(messageId) {
  feed.querySelectorAll(`[data-id="${CSS.escape(messageId)}"]`).forEach((el) => {
    el.remove();
  });
}

function findByNameText(displayName, message) {
  return [...feed.querySelectorAll(".overlay-msg")].find((li) => {
    const name = li.querySelector(".overlay-name")?.textContent;
    const text = li.dataset.rawMessage;
    return name === displayName && text === message;
  });
}

function renderBadges(badges) {
  const wrap = document.createElement("span");
  wrap.className = "overlay-badges";
  for (const b of badges ?? []) {
    if (b.url) {
      const img = document.createElement("img");
      img.className = "overlay-role";
      img.src = b.url;
      img.alt = b.title || b.id;
      img.title = b.title || b.id;
      img.width = 18;
      img.height = 18;
      wrap.appendChild(img);
    } else {
      const chip = document.createElement("span");
      chip.className = `overlay-role-chip overlay-role-chip--${b.id}`;
      chip.textContent = b.title || b.id;
      chip.title = b.title || b.id;
      wrap.appendChild(chip);
    }
  }
  return wrap;
}

function renderFragments(evt) {
  const text = document.createElement("span");
  text.className = "overlay-text";
  const fragments = evt.fragments?.length
    ? evt.fragments
    : [{ type: "text", text: evt.message }];
  for (const frag of fragments) {
    if (frag.type === "emote" && frag.url) {
      const img = document.createElement("img");
      img.className = "overlay-emote";
      img.src = frag.url;
      img.alt = frag.name || "emote";
      img.title = frag.name || "";
      img.height = 28;
      text.appendChild(img);
    } else if (frag.text) {
      text.appendChild(document.createTextNode(frag.text));
    }
  }
  return text;
}

function applyNameStyle(nameEl, evt) {
  nameEl.style.color = "";
  nameEl.style.backgroundImage = "";
  nameEl.style.webkitBackgroundClip = "";
  nameEl.style.backgroundClip = "";
  nameEl.style.webkitTextFillColor = "";
  nameEl.classList.remove("overlay-name--paint");

  // Cor nativa da plataforma de origem ganha de paint/cor 7TV
  if (evt.color) {
    nameEl.style.color = evt.color;
    return;
  }
  if (evt.sevenTvPaintCss) {
    nameEl.classList.add("overlay-name--paint");
    nameEl.style.backgroundImage = evt.sevenTvPaintCss;
    nameEl.style.webkitBackgroundClip = "text";
    nameEl.style.backgroundClip = "text";
    nameEl.style.webkitTextFillColor = "transparent";
    return;
  }
  if (evt.sevenTvColor) nameEl.style.color = evt.sevenTvColor;
}

function appendMessage(evt) {
  const existingById = feed.querySelector(
    `[data-id="${CSS.escape(evt.messageId)}"]`,
  );

  // Nunca trocar badge Kick/YouTube por Twitch (eco cru)
  if (
    existingById &&
    existingById.dataset.platform &&
    existingById.dataset.platform !== "twitch" &&
    evt.platform === "twitch"
  ) {
    return;
  }

  // Enriquecimento linked: mesmo nick+texto, troca o item antigo (ids Helix/IRC)
  const existingByContent = findByNameText(evt.displayName, evt.message);
  if (
    evt.linked &&
    existingByContent &&
    existingByContent.dataset.id !== evt.messageId
  ) {
    const prevPlatform = existingByContent.dataset.platform;
    if (prevPlatform && prevPlatform !== "twitch" && evt.platform === "twitch") {
      return;
    }
    existingByContent.remove();
  } else if (evt.platform === "twitch") {
    const dup = findByNameText(evt.displayName, evt.message);
    if (
      dup &&
      dup.dataset.platform &&
      dup.dataset.platform !== "twitch"
    ) {
      return;
    }
  }

  removeMessage(evt.messageId);
  const li = document.createElement("li");
  li.className = "overlay-msg";
  li.dataset.id = evt.messageId;
  li.dataset.platform = evt.platform;
  li.dataset.rawMessage = evt.message;

  const platform = document.createElement("img");
  platform.className = `overlay-badge overlay-badge--${evt.platform}`;
  platform.src = PLATFORM_ICON[evt.platform] ?? PLATFORM_ICON.twitch;
  platform.alt = PLATFORM_LABEL[evt.platform] ?? evt.platform;
  platform.width = 18;
  platform.height = 18;

  const roleBadges = renderBadges(evt.badges);

  const name = document.createElement("span");
  name.className = "overlay-name";
  name.textContent = evt.displayName;
  applyNameStyle(name, evt);

  const text = renderFragments(evt);

  li.append(platform, roleBadges, name, text);
  feed.appendChild(li);

  while (feed.children.length > MAX_MESSAGES) {
    feed.firstElementChild?.remove();
  }

  requestAnimationFrame(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
}

async function boot() {
  if (!token) {
    showStatus("Token ausente. Gere a URL no painel.", true);
    return;
  }

  try {
    const meRes = await fetch(`/api/overlay/me?token=${encodeURIComponent(token)}`);
    if (!meRes.ok) throw new Error("Token inválido");
    const me = await meRes.json();
    document.title = `Overlay — @${me.twitchLogin}`;
  } catch {
    showStatus("Token inválido.", true);
    return;
  }

  const es = new EventSource(
    `/api/overlay/stream?token=${encodeURIComponent(token)}`,
  );

  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "hello") {
      showStatus("");
      return;
    }
    if (data.type === "message") {
      appendMessage(data);
      return;
    }
    if (data.type === "delete") {
      removeMessage(data.messageId);
    }
  };

  es.onerror = () => {
    showStatus("Reconectando…", true);
  };
}

boot();
