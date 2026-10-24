/* =========================================================================
 * Video Mapper — écran de sortie (vidéoprojection)
 * ========================================================================= */
(function () {
  const $ = (s) => document.querySelector(s);

  let state = VM.loadState(); // démarre même si l'éditeur est fermé
  let editorLastSeen = 0;
  const stageBox = $("#stage");

  const engine = VM.createEngine(stageBox, {
    role: "output",
    getState: () => state,
    fit: (c) => VM.fitCanvas(c, stageBox),
    onMediaStatus(id, status) {
      if (status === "audio-blocked") showOverlay(true);
    },
    onEnded(id) {
      chan.send({ type: "ended", id });
    },
  });

  const chan = VM.createChannel("output", (m) => {
    switch (m.type) {
      case "state":
        editorLastSeen = Date.now();
        state = VM.sanitizeState(m.state);
        engine.sync();
        renderBadge();
        break;
      case "surface": {
        const L = state.layers.find((l) => l.id === m.id);
        if (L) L.surface = m.json;
        engine.setSurfaceJSON(m.id, m.json);
        break;
      }
      case "cmd":
        (m.cmds || []).forEach((c) => c.cmd === "restart" && engine.restart(c.id));
        break;
      case "ping":
        editorLastSeen = Date.now();
        break;
      case "bye":
        editorLastSeen = 0;
        break;
    }
  });

  chan.send({ type: "hello" });
  setInterval(() => {
    chan.send({
      type: "ping",
      info: { fullscreen: !!document.fullscreenElement, audioBlocked: engine.isAudioBlocked() },
    });
    chan.send({ type: "times", times: engine.times() });
  }, 1000);
  window.addEventListener("beforeunload", () => chan.send({ type: "bye" }));

  const refit = () => engine.p && VM.fitCanvas(engine.p.canvas, stageBox);
  window.addEventListener("resize", refit);
  document.addEventListener("fullscreenchange", refit);

  /* ------------------------------- Clavier -------------------------------- */

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const editorAlive = Date.now() - editorLastSeen < 3500;
    if (editorAlive) {
      // l'éditeur reste maître de l'état : on lui transmet la touche
      if (state.bindings.some((b) => VM.normKey(b.key) === VM.normKey(e.key))) {
        e.preventDefault();
        chan.send({ type: "key", key: e.key });
      }
    } else {
      // éditeur fermé : la sortie applique elle-même les raccourcis
      const { hit, cmds } = VM.runKey(state, e.key);
      if (hit) {
        e.preventDefault();
        engine.sync();
        cmds.forEach((c) => c.cmd === "restart" && engine.restart(c.id));
      }
    }
  });

  /* ------------------------- Plein écran & activation ---------------------- */

  const overlay = $("#overlay");

  function showOverlay(on) {
    overlay.hidden = !on;
    document.body.classList.toggle("cursor", on);
  }

  function activate() {
    engine.unlockAudio();
    showOverlay(false);
  }

  let goFullscreen = async function (screen) {
    activate();
    try {
      await document.documentElement.requestFullscreen(screen ? { screen, navigationUI: "hide" } : { navigationUI: "hide" });
    } catch (e) {
      console.warn("Plein écran refusé", e);
    }
  };

  $("#btnFs").onclick = () => goFullscreen();
  $("#btnWindow").onclick = activate;

  // App Electron : son autorisé d'office, plein écran géré par la fenêtre native
  const native = window.vmNative || null;
  if (native) {
    activate();
    goFullscreen = async () => native.toggleFullscreen();
  }

  // Chrome / Edge : choix direct de l'écran (API Window Management)
  if (!native && "getScreenDetails" in window) {
    const b = document.createElement("button");
    b.textContent = "Choisir l'écran…";
    b.title = "Lister les écrans branchés (le navigateur demande une autorisation)";
    b.onclick = async () => {
      try {
        const det = await window.getScreenDetails();
        const box = $("#fsBtns");
        box.innerHTML = "";
        det.screens.forEach((s, i) => {
          const sb = document.createElement("button");
          sb.className = s.isPrimary ? "" : "primary";
          sb.textContent = (s.label || "Écran " + (i + 1)) + " — " + s.width + "×" + s.height + (s.isPrimary ? " (principal)" : "");
          sb.onclick = () => goFullscreen(s);
          box.append(sb);
        });
      } catch (e) {
        b.textContent = "Accès aux écrans refusé";
      }
    };
    $("#fsBtns").append(b);
  }

  document.addEventListener("dblclick", () => {
    if (!overlay.hidden) return;
    if (native) return native.toggleFullscreen();
    if (document.fullscreenElement) document.exitFullscreen();
    else goFullscreen();
  });

  // curseur masqué après 2 s d'immobilité
  let curTimer;
  document.addEventListener("mousemove", () => {
    document.body.classList.add("cursor");
    clearTimeout(curTimer);
    curTimer = setTimeout(() => overlay.hidden && document.body.classList.remove("cursor"), 2000);
  });

  function renderBadge() {
    const b = $("#badge");
    b.hidden = !state.showGuides;
    b.textContent = "REPÈRES — " + state.stage.w + "×" + state.stage.h;
  }
  renderBadge();

  window.vmOutput = { get state() { return state; }, engine };
})();
