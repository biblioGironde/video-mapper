/* =========================================================================
 * Video Mapper — état partagé, médias (IndexedDB), canal entre onglets,
 * moteur d'actions clavier.
 * ========================================================================= */
(function () {
  const VM = (window.VM = window.VM || {});

  VM.CHANNEL_NAME = "videomapper-v1";
  VM.STATE_KEY = "videomapper-state-v1";
  VM.QUAD_RES = 20; // divisions du maillage (fixe : indispensable pour recharger les coins)

  VM.uid = (p = "id") =>
    p + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

  const PALETTE = ["#ff5d73", "#4cc9f0", "#ffd166", "#06d6a0", "#b388ff", "#ff9f1c", "#90be6d", "#f72585"];

  VM.defaultState = () => ({
    version: 1,
    stage: { w: 1920, h: 1080 },
    calibrate: true, // éditeur : afficher/éditer les points
    moveMode: "ALL", // ALL | POINTS | SURFACES
    showGuides: false, // repères visibles sur la sortie
    blackout: false,
    testPattern: null, // null | "white" | "grid" : mire affichée sur la scène
    backdrop: null, // {mediaId, opacity, show} photo de repérage redressée (éditeur seulement)
    layers: [], // ordre = ordre de dessin (0 = dessous)
    bindings: [],
  });

  VM.newLayer = (state, props = {}) => {
    const n = state.layers.length;
    return Object.assign(
      {
        id: VM.uid("layer"),
        name: "Calque " + (n + 1),
        mediaId: null,
        mediaName: null,
        color: PALETTE[n % PALETTE.length],
        visible: true,
        opacity: 1,
        fade: null, // {from, to, t0, dur} — calculé localement dans chaque onglet
        playing: true,
        loop: true,
        muted: false,
        volume: 1,
        rate: 1,
        surface: null, // JSON p5.mapper (coins calibrés)
        aspect: 16 / 9,
        autoAspect: false,
        shape: "quad", // "quad" (perspective) | "circle" (ellipse en perspective) | "poly" (polygone libre)
        polyCount: 0,
        feather: 0,
        fit: "stretch", // cadrage du média : "stretch" (étirer) | "cover" (remplir) | "contain" (ajuster)
        frame: { x: 0, y: 0, zoom: 1, rot: 0 }, // décalage (fraction de la forme), zoom, rotation (°) // cercle : largeur du bord doux (0 = net, 0.5 = très doux)
      },
      props
    );
  };

  /* ------------------------------ Persistance ----------------------------- */

  VM.loadState = () => {
    try {
      const raw = localStorage.getItem(VM.STATE_KEY);
      if (!raw) return VM.defaultState();
      return VM.sanitizeState(JSON.parse(raw));
    } catch (e) {
      console.warn("État illisible, réinitialisation", e);
      return VM.defaultState();
    }
  };

  VM.saveState = (state) => {
    try {
      localStorage.setItem(VM.STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Sauvegarde impossible", e);
    }
  };

  VM.sanitizeState = (s) => {
    const d = VM.defaultState();
    const out = Object.assign(d, s || {});
    out.stage = Object.assign({ w: 1920, h: 1080 }, out.stage || {});
    out.layers = (out.layers || []).map((l) => VM.newLayer(out, l));
    out.bindings = out.bindings || [];
    return out;
  };

  /* --------------------------- Médias (IndexedDB) -------------------------- */

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("videomapper", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("media", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction("media", mode);
          const store = t.objectStore("media");
          const r = fn(store);
          t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : r);
          t.onerror = () => reject(t.error);
        })
    );
  }

  VM.mediaKind = (type, name = "") => {
    if (/^video\//.test(type) || /\.(webm|mp4|mov|m4v|ogv)$/i.test(name)) return "video";
    if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)) return "image";
    return null;
  };

  VM.putMedia = async (file, extra = {}) => {
    const kind = VM.mediaKind(file.type, file.name);
    if (!kind) throw new Error("Format non pris en charge : " + file.name);
    const rec = Object.assign({ id: VM.uid("media"), name: file.name, type: file.type, kind, size: file.size, blob: file, added: Date.now() }, extra);
    await tx("readwrite", (s) => s.put(rec));
    return rec;
  };
  VM.getMedia = (id) => tx("readonly", (s) => s.get(id));
  VM.deleteMedia = (id) => tx("readwrite", (s) => s.delete(id));
  VM.listMedia = async () => {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || [])
      .filter((r) => !r.hidden) // photos de repérage internes
      .sort((a, b) => a.added - b.added)
      .map(({ blob, ...meta }) => meta);
  };

  /* ---------------------------- Canal entre onglets ------------------------ */

  VM.createChannel = (role, onMessage) => {
    const ch = new BroadcastChannel(VM.CHANNEL_NAME);
    ch.onmessage = (e) => {
      if (!e.data || e.data.from === role) return;
      onMessage(e.data);
    };
    return {
      send(msg) {
        ch.postMessage(Object.assign({ from: role }, msg));
      },
      close() {
        ch.close();
      },
    };
  };

  /* ------------------------------ Actions clavier -------------------------- */

  VM.ACTIONS = {
    toggle: { label: "Afficher / masquer", layer: true },
    show: { label: "Afficher", layer: true },
    hide: { label: "Masquer", layer: true },
    solo: { label: "Solo (masquer les autres)", layer: true },
    fadein: { label: "Fondu entrant", layer: true, param: "durée (s)", def: 2 },
    fadeout: { label: "Fondu sortant", layer: true, param: "durée (s)", def: 2 },
    playpause: { label: "Lecture / pause", layer: true },
    restart: { label: "Revenir au début", layer: true },
    mute: { label: "Couper / rétablir le son", layer: true },
    loop: { label: "Boucle on / off", layer: true },
    allplay: { label: "Tout : lecture / pause", layer: false },
    allrestart: { label: "Tout : revenir au début", layer: false },
    blackout: { label: "Noir général on / off", layer: false },
  };

  /** Opacité effective d'un calque à l'instant présent (tient compte du fondu). */
  VM.effectiveOpacity = (l, now = Date.now()) => {
    if (!l.fade) return l.visible ? l.opacity : 0;
    const k = Math.min(1, Math.max(0, (now - l.fade.t0) / (l.fade.dur * 1000)));
    return l.fade.from + (l.fade.to - l.fade.from) * k;
  };

  function settleFade(l) {
    // fige un fondu en cours avant d'en lancer un autre
    if (!l.fade) return;
    const cur = VM.effectiveOpacity(l);
    l.fade = null;
    l.visible = cur > 0.001;
    if (l.visible) l.opacity = cur;
  }

  /**
   * Applique une action à l'état (mutation). Retourne la liste des commandes
   * ponctuelles à diffuser (ex. retour au début).
   */
  VM.applyAction = (state, b) => {
    const cmds = [];
    const L = state.layers.find((x) => x.id === b.layerId);
    const def = VM.ACTIONS[b.action];
    if (!def) return cmds;
    if (def.layer && !L) return cmds;
    const now = Date.now();
    switch (b.action) {
      case "toggle":
        settleFade(L);
        L.visible = !L.visible;
        if (L.visible && L.opacity <= 0.001) L.opacity = 1;
        break;
      case "show":
        settleFade(L);
        L.visible = true;
        if (L.opacity <= 0.001) L.opacity = 1;
        break;
      case "hide":
        settleFade(L);
        L.visible = false;
        break;
      case "solo":
        state.layers.forEach((x) => {
          settleFade(x);
          x.visible = x.id === L.id;
        });
        if (L.opacity <= 0.001) L.opacity = 1;
        break;
      case "fadein": {
        const from = VM.effectiveOpacity(L, now);
        const to = L.fade ? Math.max(L.fade.to, L.fade.from, 1) : L.opacity > 0.001 ? L.opacity : 1;
        L.fade = { from, to: Math.min(1, to), t0: now, dur: Math.max(0.05, +b.param || 2) };
        L.visible = true;
        L.opacity = L.fade.to;
        break;
      }
      case "fadeout": {
        const from = VM.effectiveOpacity(L, now);
        const restore = L.fade ? Math.max(L.fade.from, L.fade.to) : L.opacity;
        L.fade = { from, to: 0, t0: now, dur: Math.max(0.05, +b.param || 2) };
        L.visible = false;
        L.opacity = restore || 1; // opacité retrouvée au prochain « afficher »
        break;
      }
      case "playpause":
        L.playing = !L.playing;
        break;
      case "restart":
        cmds.push({ cmd: "restart", id: L.id });
        L.playing = true;
        break;
      case "mute":
        L.muted = !L.muted;
        break;
      case "loop":
        L.loop = !L.loop;
        break;
      case "allplay": {
        const anyPlaying = state.layers.some((x) => x.playing);
        state.layers.forEach((x) => (x.playing = !anyPlaying));
        break;
      }
      case "allrestart":
        state.layers.forEach((x) => {
          cmds.push({ cmd: "restart", id: x.id });
          x.playing = true;
        });
        break;
      case "blackout":
        state.blackout = !state.blackout;
        break;
    }
    return cmds;
  };

  /** Exécute toutes les liaisons associées à une touche. */
  VM.runKey = (state, key) => {
    const k = VM.normKey(key);
    let cmds = [];
    let hit = false;
    for (const b of state.bindings) {
      if (VM.normKey(b.key) === k) {
        hit = true;
        cmds = cmds.concat(VM.applyAction(state, b));
      }
    }
    return { hit, cmds };
  };

  VM.normKey = (k) => (k && k.length === 1 ? k.toLowerCase() : k || "");
  VM.keyLabel = (k) => {
    const map = { " ": "Espace", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Entrée", Backspace: "⌫", Tab: "Tab" };
    if (map[k]) return map[k];
    return k && k.length === 1 ? k.toUpperCase() : k;
  };

  VM.isTypingTarget = (el) =>
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
})();
