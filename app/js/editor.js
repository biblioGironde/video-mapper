/* =========================================================================
 * Video Mapper — écran d'édition
 * ========================================================================= */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const k in attrs) {
      const v = attrs[k];
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "html") n.innerHTML = v;
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };

  let state = VM.loadState();
  let media = []; // métadonnées de la médiathèque
  let selectedId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
  const mediaStatus = {}; // layerId -> {status, aspect, duration}
  let outLastSeen = 0;
  let outInfo = {};
  let listeningBinding = null;

  /* ------------------------------ Canal & moteur --------------------------- */

  const chan = VM.createChannel("editor", onMessage);

  const stageBox = $("#stage");
  const engine = VM.createEngine(stageBox, {
    role: "editor",
    getState: () => state,
    getSelectedId: () => selectedId,
    fit: (c) => VM.fitCanvas(c, stageBox),
    onSurfaceChange(id, json, dragging) {
      const L = byId(id);
      if (!L) return;
      L.surface = json;
      chan.send({ type: "surface", id, json });
      saveSoon();
    },
    onSelectLayer(id) {
      if (id !== selectedId) select(id);
    },
    onMediaStatus(id, status, info) {
      mediaStatus[id] = Object.assign(mediaStatus[id] || {}, { status }, info || {});
      const L = byId(id);
      if (L && status === "ready" && L.autoAspect && info && info.aspect) {
        // calque neuf : la surface prend les proportions réelles du média
        L.autoAspect = false;
        if (Math.abs(L.aspect - info.aspect) > 0.01) {
          L.aspect = info.aspect;
          L.surface = engine.resetSurface(id);
        }
        commit({ props: id === selectedId });
        return;
      }
      renderLayers();
      if (id === selectedId && status === "ready") renderProps();
    },
  });

  window.addEventListener("resize", () => engine.p && VM.fitCanvas(engine.p.canvas, stageBox));

  function onMessage(m) {
    switch (m.type) {
      case "hello":
        outLastSeen = Date.now();
        chan.send({ type: "state", state });
        renderOutStatus();
        break;
      case "ping":
        outLastSeen = Date.now();
        outInfo = m.info || {};
        renderOutStatus();
        break;
      case "bye":
        outLastSeen = 0;
        renderOutStatus();
        break;
      case "key":
        handleKey(m.key);
        break;
      case "times":
        if (document.visibilityState === "visible") engine.applyTimes(m.times);
        break;
      case "ended": {
        const L = byId(m.id);
        if (L && !L.loop && L.playing) {
          L.playing = false;
          commit();
        }
        break;
      }
    }
  }

  setInterval(() => chan.send({ type: "ping" }), 1000);
  setInterval(renderOutStatus, 1500);
  window.addEventListener("beforeunload", () => chan.send({ type: "bye" }));

  /* ------------------------------- Mutations ------------------------------ */

  const byId = (id) => state.layers.find((l) => l.id === id);
  const selected = () => byId(selectedId);

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => VM.saveState(state), 300);
  }

  /** Valide un changement d'état : sauvegarde, diffusion, moteur, interface. */
  function commit(opts = {}) {
    saveSoon();
    chan.send({ type: "state", state });
    engine.sync();
    if (opts.render !== false) {
      renderTop();
      renderLayers();
      if (opts.props !== false) renderProps();
      if (opts.bindings) renderBindings();
      renderMedia();
    }
  }

  function sendCmds(cmds) {
    if (!cmds.length) return;
    cmds.forEach((c) => c.cmd === "restart" && engine.restart(c.id));
    chan.send({ type: "cmd", cmds });
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ------------------------------ Import médias --------------------------- */

  const MEDIA_MIME = "application/x-vm-media"; // glisser depuis la médiathèque

  const layerTitle = (L) => "« " + L.name + " »";

  /** Place un média dans la forme d'un calque existant. */
  function assignMedia(L, rec, { quiet = false } = {}) {
    L.mediaId = rec.id;
    L.mediaName = rec.name;
    L.autoAspect = false; // la forme est gardée telle quelle
    selectedId = L.id;
    commit();
    if (!quiet) toast(rec.name + " → " + layerTitle(L));
  }

  function newMediaLayer(rec) {
    const L = VM.newLayer(state, {
      name: rec.name.replace(/\.[^.]+$/, ""),
      mediaId: rec.id,
      mediaName: rec.name,
      autoAspect: true, // proportions ajustées au premier chargement du média
    });
    state.layers.push(L);
    selectedId = L.id;
    commit();
    return L;
  }

  /**
   * Importe des fichiers dans la médiathèque.
   *  - target : calque dont la forme reçoit le premier fichier
   *  - sinon, si le calque sélectionné est une forme vide, elle reçoit le premier fichier
   *  - les autres fichiers deviennent de nouveaux calques
   */
  async function importFiles(files, { target = null, fillSelected = true } = {}) {
    let dest = target;
    if (!dest && fillSelected) {
      const S = selected();
      if (S && !S.mediaId) dest = S;
    }
    let added = 0;
    const msgs = [];
    for (const f of files) {
      try {
        const rec = await VM.putMedia(f);
        added++;
        if (dest) {
          assignMedia(dest, rec, { quiet: true });
          msgs.push(rec.name + " → " + layerTitle(dest));
          dest = null;
        } else {
          newMediaLayer(rec);
        }
      } catch (e) {
        toast(e.message);
      }
    }
    await refreshMedia();
    if (added) {
      commit();
      const extra = added - msgs.length;
      toast(msgs.concat(extra ? [extra + (extra > 1 ? " nouveaux calques" : " nouveau calque")] : []).join(" · "));
    }
  }

  async function refreshMedia() {
    media = await VM.listMedia();
    renderMedia();
    renderProps();
  }

  $("#fileMedia").addEventListener("change", (e) => {
    importFiles([...e.target.files]);
    e.target.value = "";
  });

  const isMediaDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].some((t) => t === "Files" || t === MEDIA_MIME);

  /** Dépôt d'un fichier ou d'un média de la médiathèque, vers un calque (ou un nouveau calque). */
  async function dropOn(e, L) {
    const id = e.dataTransfer.getData(MEDIA_MIME);
    if (id) {
      const rec = media.find((m) => m.id === id);
      if (!rec) return;
      if (L) assignMedia(L, rec);
      else newMediaLayer(rec);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) importFiles(files, { target: L, fillSelected: false });
  }

  // scène : on dépose dans la forme survolée, sinon nouveau calque
  const wrap = $("#stageWrap");
  let dropTarget = null;
  ["dragenter", "dragover"].forEach((ev) =>
    wrap.addEventListener(ev, (e) => {
      if (!isMediaDrag(e)) return;
      e.preventDefault();
      wrap.classList.add("dragover");
      const id = engine.layerAt(e.clientX, e.clientY);
      if (id !== dropTarget) {
        dropTarget = id;
        engine.setHighlight(id);
        const L = byId(id);
        $("#dropHint").textContent = L ? "Déposer dans la forme " + layerTitle(L) : "Déposer : nouveau calque";
      }
    })
  );
  const endDrag = () => {
    wrap.classList.remove("dragover");
    engine.setHighlight(null);
    dropTarget = null;
  };
  wrap.addEventListener("dragleave", (e) => {
    if (!wrap.contains(e.relatedTarget)) endDrag();
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    const L = byId(engine.layerAt(e.clientX, e.clientY));
    endDrag();
    dropOn(e, L);
  });

  /* -------------------------------- Barre haute --------------------------- */

  let outWin = null;
  const native = window.vmNative || null; // présent dans l'app Electron
  let nativeState = null;

  $("#btnOpenOutput").onclick = () => {
    if (native) {
      const id = $("#selDisplay").value;
      native.openOutput(id ? +id : null);
      return;
    }
    outWin = window.open("sortie.html", "videomapper-output");
    if (!outWin) toast("Fenêtre bloquée : autorisez les pop-ups pour cette page");
  };

  /* ------------------------- App Electron (natif) ------------------------- */

  function renderDisplays() {
    if (!native || !nativeState) return;
    const sel = $("#selDisplay");
    const cur = nativeState.displayId;
    sel.innerHTML = "";
    nativeState.displays.forEach((d) => {
      sel.append(el("option", { value: d.id, selected: d.id === cur }, (d.primary ? "🖥 " : "📽 ") + d.label + " — " + d.width + "×" + d.height));
    });
    sel.hidden = false;
    $("#btnOutFs").hidden = !nativeState.open;
    $("#btnOutFs").classList.toggle("on", nativeState.fullscreen);
    $("#btnOpenOutput").textContent = nativeState.open ? "Déplacer la sortie" : "Ouvrir la sortie";
    renderOutStatus();
  }

  if (native) {
    document.body.classList.add("native");
    native.getState().then((s) => {
      nativeState = s;
      renderDisplays();
    });
    native.onOutputState((s) => {
      const before = nativeState ? nativeState.displays.length : null;
      nativeState = s;
      renderDisplays();
      if (before !== null && s.displays.length > before) toast("Nouvel écran détecté");
    });
    $("#selDisplay").addEventListener("change", (e) => {
      if (nativeState && nativeState.open) native.openOutput(+e.target.value);
    });
    $("#btnOutFs").onclick = () => native.toggleFullscreen();

    native.onMenu((action) => {
      switch (action) {
        case "import-media": $("#fileMedia").click(); break;
        case "photo": $("#btnPhoto").click(); break;
        case "import-project": $("#fileImport").click(); break;
        case "export-project": $("#btnExport").click(); break;
        case "blackout": run({ action: "blackout" }); break;
        case "allplay": run({ action: "allplay" }); break;
        case "allrestart": run({ action: "allrestart" }); break;
        case "calibrate":
          state.calibrate = !state.calibrate;
          commit({ props: false });
          break;
        case "guides":
          state.showGuides = !state.showGuides;
          commit({ props: false });
          break;
      }
    });
  }

  $("#selStage").addEventListener("change", (e) => {
    let v = e.target.value;
    if (v === "custom") {
      const r = prompt("Résolution de projection (largeur x hauteur)", state.stage.w + "x" + state.stage.h);
      if (!r) return renderTop();
      v = r.replace(/\s/g, "");
    }
    const m = /^(\d{3,5})[x×](\d{3,5})$/i.exec(v);
    if (!m) {
      toast("Format attendu : 1920x1080");
      return renderTop();
    }
    state.stage = { w: +m[1], h: +m[2] };
    commit();
  });

  $("#segCalib").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const v = b.dataset.v;
    if (v === "off") {
      state.calibrate = false;
      if (state.moveMode === "MEDIA") state.moveMode = "ALL";
    } else if (v === "MEDIA") {
      state.calibrate = false; // pas de poignées p5.mapper : la souris cadre le média
      state.moveMode = "MEDIA";
    } else {
      state.calibrate = true;
      state.moveMode = v;
    }
    applyMoveMode();
    commit({ props: false });
  });

  /* ------------------------- Cadrer le média (souris) ---------------------- */

  const mediaMode = () => !state.calibrate && state.moveMode === "MEDIA";
  const frameOf = (L) => (L.frame = Object.assign({ x: 0, y: 0, zoom: 1, rot: 0 }, L.frame || {}));
  let frameDrag = null;
  let frameRaf = 0;
  const pushFrame = () => {
    // pendant un geste : on diffuse sans reconstruire l'interface, au plus une fois par image
    if (frameRaf) return;
    frameRaf = requestAnimationFrame(() => {
      frameRaf = 0;
      commit({ render: false });
    });
  };

  stageBox.addEventListener("pointerdown", (e) => {
    if (!mediaMode()) return;
    const id = engine.layerAt(e.clientX, e.clientY);
    if (!id) return;
    if (id !== selectedId) select(id);
    const L = byId(id);
    if (!L.mediaId) return toast("Cette forme n'a pas encore de média");
    const uv = engine.uvAt(id, e.clientX, e.clientY);
    if (!uv) return;
    frameDrag = { id, uv0: uv, f0: Object.assign({}, frameOf(L)) };
    stageBox.setPointerCapture(e.pointerId);
    stageBox.classList.add("grabbing");
    e.preventDefault();
  });
  stageBox.addEventListener("pointermove", (e) => {
    if (!frameDrag) return;
    const L = byId(frameDrag.id);
    const uv = engine.uvAt(frameDrag.id, e.clientX, e.clientY);
    if (!L || !uv) return;
    const f = frameOf(L);
    f.x = frameDrag.f0.x + (uv.u - frameDrag.uv0.u);
    f.y = frameDrag.f0.y + (uv.v - frameDrag.uv0.v);
    pushFrame();
  });
  const endFrameDrag = () => {
    if (!frameDrag) return;
    frameDrag = null;
    stageBox.classList.remove("grabbing");
    commit();
  };
  stageBox.addEventListener("pointerup", endFrameDrag);
  stageBox.addEventListener("pointercancel", endFrameDrag);

  stageBox.addEventListener("wheel", (e) => {
    if (!mediaMode()) return;
    const id = engine.layerAt(e.clientX, e.clientY) || selectedId;
    const L = byId(id);
    if (!L || !L.mediaId) return;
    e.preventDefault();
    if (id !== selectedId) select(id);
    const f = frameOf(L);
    const d = e.deltaY || e.deltaX;
    if (e.shiftKey || e.altKey) {
      f.rot = Math.round(((f.rot + Math.sign(d) * 2 + 540) % 360) - 180);
    } else {
      // zoom autour du point sous le curseur
      const k = Math.min(1.25, Math.max(0.8, Math.exp(-d * 0.0015)));
      const z = Math.min(8, Math.max(0.05, f.zoom * k));
      const kk = z / f.zoom;
      const uv = engine.uvAt(id, e.clientX, e.clientY) || { u: 0.5, v: 0.5 };
      f.x = uv.u + (0.5 + f.x - uv.u) * kk - 0.5;
      f.y = uv.v + (0.5 + f.y - uv.v) * kk - 0.5;
      f.zoom = z;
    }
    pushFrame();
    clearTimeout(stageBox._wheelT);
    stageBox._wheelT = setTimeout(() => renderProps(), 250);
  }, { passive: false });

  stageBox.addEventListener("dblclick", (e) => {
    if (!mediaMode()) return;
    const L = byId(engine.layerAt(e.clientX, e.clientY));
    if (!L || !L.mediaId) return;
    L.frame = { x: 0, y: 0, zoom: 1, rot: 0 };
    commit();
    toast("Média recentré dans " + layerTitle(L));
  });

  function applyMoveMode() {
    const pm = engine.pMapper;
    if (!pm) return;
    stageBox.classList.toggle("media-mode", mediaMode());
    if (state.moveMode === "POINTS") pm.moveControlPoints();
    else if (state.moveMode === "SURFACES") pm.moveSurfaces();
    else pm.moveAll();
  }
  // le moteur est prêt après le setup p5
  const waitReady = setInterval(() => {
    if (engine.ready()) {
      clearInterval(waitReady);
      applyMoveMode();
    }
  }, 50);

  $("#chkGuides").addEventListener("change", (e) => {
    state.showGuides = e.target.checked;
    commit({ props: false });
  });
  $("#btnBlackout").onclick = () => run({ action: "blackout" });
  $("#btnAllPlay").onclick = () => run({ action: "allplay" });
  $("#btnAllRestart").onclick = () => run({ action: "allrestart" });

  function run(binding) {
    const cmds = VM.applyAction(state, binding);
    sendCmds(cmds);
    commit();
  }

  /* --------------------------------- Projet ------------------------------- */

  $("#btnExport").onclick = () => {
    const data = JSON.stringify(Object.assign({ app: "videomapper", exported: new Date().toISOString() }, state), null, 2);
    const a = el("a", { href: URL.createObjectURL(new Blob([data], { type: "application/json" })), download: "mapping-" + new Date().toISOString().slice(0, 10) + ".json" });
    document.body.append(a);
    a.click();
    a.remove();
    toast("Projet exporté (les vidéos restent dans ce navigateur)");
  };

  $("#fileImport").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const next = VM.sanitizeState(json);
      await refreshMedia();
      // reconnexion des médias par nom de fichier si l'identifiant est inconnu
      let missing = 0;
      for (const L of next.layers) {
        if (L.mediaId && !media.some((m) => m.id === L.mediaId)) {
          const hit = media.find((m) => m.name === L.mediaName);
          if (hit) L.mediaId = hit.id;
          else missing++;
        }
      }
      state = next;
      selectedId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
      applyMoveMode();
      commit({ bindings: true });
      toast(missing ? missing + " média(s) à réimporter (voir calques en orange)" : "Projet chargé");
    } catch (err) {
      toast("Fichier de projet illisible");
      console.error(err);
    }
  });

  /* -------------------------------- Clavier ------------------------------- */

  document.addEventListener("keydown", (e) => {
    if (listeningBinding) {
      e.preventDefault();
      if (e.key === "Escape") {
        listeningBinding = null;
        renderBindings();
        return;
      }
      const b = state.bindings.find((x) => x.id === listeningBinding);
      if (b) b.key = e.key;
      listeningBinding = null;
      commit({ bindings: true, props: false });
      return;
    }
    if (VM.isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (handleKey(e.key)) e.preventDefault();
  });

  function handleKey(key) {
    const { hit, cmds } = VM.runKey(state, key);
    if (!hit) return false;
    sendCmds(cmds);
    commit();
    document.querySelectorAll(".keycap").forEach((k) => {
      if (VM.normKey(k.dataset.key) === VM.normKey(key)) {
        k.classList.add("flash");
        setTimeout(() => k.classList.remove("flash"), 180);
      }
    });
    return true;
  }

  $("#btnAddBinding").onclick = () => {
    const b = { id: VM.uid("bind"), key: "", action: "toggle", layerId: selectedId || (state.layers[0] && state.layers[0].id) || null, param: 2 };
    state.bindings.push(b);
    listeningBinding = b.id;
    commit({ bindings: true, props: false });
  };

  /* ------------------------------- Rendus UI ------------------------------ */

  function renderOutStatus() {
    const s = $("#outStatus");
    const alive = Date.now() - outLastSeen < 3500;
    if (!alive) {
      s.className = "status off";
      s.textContent = "sortie fermée";
    } else if (outInfo.audioBlocked) {
      s.className = "status warn";
      s.textContent = "sortie : cliquez-la pour le son";
    } else {
      const fsOn = nativeState ? nativeState.fullscreen : outInfo.fullscreen;
      s.className = "status on";
      s.textContent = fsOn ? "sortie plein écran" : "sortie connectée";
    }
  }

  function renderTop() {
    const sel = $("#selStage");
    const v = state.stage.w + "x" + state.stage.h;
    if (![...sel.options].some((o) => o.value === v)) {
      sel.insertBefore(el("option", { value: v }, state.stage.w + " × " + state.stage.h), sel.lastElementChild);
    }
    sel.value = v;
    document.querySelectorAll("#segCalib button").forEach((b) => {
      const v = b.dataset.v;
      const on = v === "off" ? !state.calibrate && state.moveMode !== "MEDIA" : v === "MEDIA" ? mediaMode() : state.calibrate && state.moveMode === v;
      b.classList.toggle("on", on);
    });
    $("#chkGuides").checked = !!state.showGuides;
    $("#selPattern").value = state.testPattern || "";
    $("#backdropCtl").hidden = !state.backdrop;
    if (state.backdrop) {
      $("#chkBackdrop").checked = !!state.backdrop.show;
      $("#rngBackdrop").value = state.backdrop.opacity ?? 0.5;
    }
    $("#btnBlackout").classList.toggle("on", !!state.blackout);
    stageBox.classList.toggle("media-mode", mediaMode());
    $("#stageHelp").innerHTML = mediaMode()
      ? "<b>Cadrer le média</b> — glissez pour déplacer la vidéo / l'image dans sa forme, molette = zoom, Maj + molette = rotation, double-clic = recentrer."
      : !state.calibrate
      ? "<b>Lecture</b> — aucune poignée, la souris ne modifie rien. Choisissez un mode d'édition pour caler les formes."
      : {
          ALL: "<b>Coins + déplacer</b> — glissez un <b>coin</b> pour déformer, l'<b>intérieur</b> d'une forme pour la déplacer. Clic = sélection du calque.",
          POINTS: "<b>Coins seuls</b> — seuls les coins et sommets bougent : idéal pour le calage fin sans décaler une forme par erreur.",
          SURFACES: "<b>Déplacer seul</b> — les formes se déplacent en bloc, leurs coins sont verrouillés (garde la déformation).",
        }[state.moveMode] || "";
  }

  function layerSub(L) {
    const st = mediaStatus[L.id];
    if (!L.mediaId) return { t: "forme vide — glissez un média ici", c: "slot" };
    if (!media.some((m) => m.id === L.mediaId) || (st && st.status === "missing")) return { t: "média manquant : " + (L.mediaName || "?"), c: "missing" };
    const flags = [];
    const m = media.find((x) => x.id === L.mediaId);
    if (m && m.kind === "video") {
      flags.push(L.playing ? "▶" : "❚❚");
      if (L.loop) flags.push("⟳");
      if (L.muted) flags.push("muet");
    }
    return { t: flags.join(" ") + "  " + (L.mediaName || ""), c: "" };
  }

  function renderLayers() {
    const ul = $("#layerList");
    ul.innerHTML = "";
    if (!state.layers.length) {
      ul.append(el("li", { class: "empty" }, "Aucun calque — importez une vidéo ou déposez-la sur la scène."));
      return;
    }
    const n = state.layers.length;
    [...state.layers].reverse().forEach((L, ri) => {
      const idx = n - 1 - ri;
      const sub = layerSub(L);
      const li = el(
        "li",
        {
          class: "layer" + (L.id === selectedId ? " sel" : "") + (L.visible ? "" : " hidden") + (L.mediaId ? "" : " no-media"),
          onclick: () => select(L.id),
          title: L.mediaId ? "" : "Glissez ici un fichier ou un média de la médiathèque",
          ondragover: (e) => {
            if (!isMediaDrag(e)) return;
            e.preventDefault();
            li.classList.add("drop");
            engine.setHighlight(L.id);
          },
          ondragleave: () => {
            li.classList.remove("drop");
            engine.setHighlight(null);
          },
          ondrop: (e) => {
            e.preventDefault();
            li.classList.remove("drop");
            engine.setHighlight(null);
            dropOn(e, L);
          },
        },
        el(
          "button",
          {
            class: "icon",
            title: L.visible ? "Masquer" : "Afficher",
            onclick: (e) => {
              e.stopPropagation();
              run({ action: "toggle", layerId: L.id });
            },
          },
          L.visible ? "👁" : "–"
        ),
        el("span", { class: "swatch", style: "background:" + L.color }),
        el("div", { class: "name" }, el("b", {}, el("span", { class: "shape", title: shapeLabel(L) }, shapeIcon(L)), L.name), el("small", { class: sub.c }, sub.t)),
        el(
          "div",
          { class: "acts" },
          el("button", { class: "icon", title: "Monter", disabled: idx === n - 1, onclick: (e) => (e.stopPropagation(), move(L.id, 1)) }, "↑"),
          el("button", { class: "icon", title: "Descendre", disabled: idx === 0, onclick: (e) => (e.stopPropagation(), move(L.id, -1)) }, "↓")
        )
      );
      ul.append(li);
    });
  }

  const shapeIcon = (L) => (L.shape === "poly" ? "⬠" : L.shape === "circle" ? "◯" : "▱");
  const shapeLabel = (L) =>
    L.shape === "poly" ? "Polygone, " + (L.polyCount || "?") + " points" : L.shape === "circle" ? "Cercle / ellipse (perspective)" : "Quadrilatère (perspective)";

  function select(id) {
    selectedId = id;
    renderLayers();
    renderProps();
    renderMedia();
  }

  function move(id, dir) {
    const i = state.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.layers.length) return;
    [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    commit({ props: false });
  }

  const POLY_PRESETS = [
    [3, "△ Triangle"],
    [4, "◇ Losange / 4 points libres"],
    [5, "⬠ Pentagone"],
    [6, "⬡ Hexagone"],
    [8, "⯃ Octogone"],
  ];

  function shapeSelect(L) {
    const cur = L.shape === "poly" ? "poly:" + (L.polyCount || 0) : L.shape === "circle" ? "circle" : "quad";
    const known = POLY_PRESETS.some(([n]) => cur === "poly:" + n);
    const others = state.layers.filter((T) => T.id !== L.id).sort((a, b) => (a.mediaId ? 1 : 0) - (b.mediaId ? 1 : 0));
    return el(
      "select",
      {
        title: "Forme de ce calque",
        onchange: (e) => {
          const v = e.target.value;
          if (v.startsWith("from:")) {
            const T = byId(v.slice(5));
            if (T) placeInShape(L, T);
          } else if (v === "quad" || v === "circle") setShape(L, v);
          else if (v.startsWith("poly:")) setShape(L, "poly", +v.slice(5));
        },
      },
      el("option", { value: "quad", selected: cur === "quad" }, "▱ Rectangle déformable (perspective)"),
      el("option", { value: "circle", selected: cur === "circle" }, "◯ Cercle / ellipse (perspective)"),
      POLY_PRESETS.map(([n, label]) => el("option", { value: "poly:" + n, selected: cur === "poly:" + n }, label + " (masque)")),
      !known && L.shape === "poly" ? el("option", { value: cur, selected: true }, "⬠ Polygone, " + L.polyCount + " points") : null,
      others.length
        ? el("optgroup", { label: "Reprendre la forme de…" },
            others.map((T) => el("option", { value: "from:" + T.id }, shapeIcon(T) + " " + T.name + (T.mediaId ? "" : " (forme vide)"))))
        : null
    );
  }

  /** Change la nature de la forme en gardant son emprise sur la scène. */
  function setShape(L, kind, n = 0) {
    const poly = engine.outline(L.id);
    if (!poly) return;
    const xs = poly.map((q) => q.x),
      ys = poly.map((q) => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (kind === "quad" || kind === "circle") {
      // un quadrilatère garde ses coins ; sinon on prend le rectangle englobant
      let corners = poly.length === 4 ? VM.geom.orderQuad(poly) : [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      if (kind === "circle" && L.shape !== "quad" && L.shape !== "circle") {
        // depuis un polygone : un carré centré, pour partir d'un vrai cercle
        const r = Math.max(rx, ry);
        corners = [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r }];
      }
      if (kind === "circle" && (!L.fit || L.fit === "stretch")) L.fit = "cover"; // un disque ne déforme pas la vidéo
      L.shape = kind;
      L.polyCount = 0;
      L.surface = VM.geom.quadJSON(corners);
    } else {
      let pts;
      if (L.shape !== "poly" && n === 4 && poly.length === 4) pts = poly; // rectangle → 4 points libres, même emprise
      else if (n === 3) pts = [{ x: cx, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      else if (n === 4) pts = [{ x: cx, y: y0 }, { x: x1, y: cy }, { x: cx, y: y1 }, { x: x0, y: cy }];
      else pts = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
      });
      L.shape = "poly";
      L.polyCount = pts.length;
      L.surface = VM.geom.polyJSON(pts);
    }
    L.autoAspect = false;
    commit();
    toast("Forme de " + layerTitle(L) + " : " + shapeLabel(L));
  }

  /** Le calque L prend la forme (et la calibration) du calque T ; T est absorbé s'il est vide. */
  function placeInShape(L, T) {
    L.shape = T.shape || "quad";
    L.polyCount = T.polyCount || 0;
    L.surface = T.surface ? JSON.parse(JSON.stringify(T.surface)) : null;
    L.aspect = T.aspect;
    L.autoAspect = false;
    let msg = layerTitle(L) + " placé dans la forme de " + layerTitle(T);
    if (!T.mediaId) {
      // la forme vide n'a plus de raison d'être : on la remplace par ce calque, à sa place dans la pile
      state.layers = state.layers.filter((x) => x !== L);
      state.layers.splice(state.layers.indexOf(T), 1, L);
      state.bindings.forEach((b) => { if (b.layerId === T.id) b.layerId = L.id; });
      msg += " (forme vide remplacée)";
    }
    selectedId = L.id;
    commit({ bindings: true });
    toast(msg);
  }

  function frameSlider(L, k, label, min, max, step, fmt) {
    const f = frameOf(L);
    const val = el("span", { class: "val" }, fmt(f[k]));
    return [
      el("label", {}, label),
      el("div", { class: "row" },
        el("input", { type: "range", min, max, step, value: f[k], style: "flex:1",
          ondblclick: (e) => { f[k] = k === "zoom" ? 1 : 0; e.target.value = f[k]; val.textContent = fmt(f[k]); commit({ props: false }); },
          oninput: (e) => { f[k] = +e.target.value; val.textContent = fmt(f[k]); commit({ props: false }); } }),
        val),
    ];
  }

  function renderProps() {
    const box = $("#props");
    box.innerHTML = "";
    const L = selected();
    if (!L) {
      box.append(el("p", { class: "empty" }, "Sélectionnez un calque."));
      return;
    }
    const m = media.find((x) => x.id === L.mediaId);
    const isVideo = m && m.kind === "video";
    const set = (k, v, o = {}) => {
      L[k] = v;
      commit(Object.assign({ props: false }, o));
    };

    const mediaSel = el(
      "select",
      { onchange: (e) => {
          const mm = media.find((x) => x.id === e.target.value);
          L.mediaId = mm ? mm.id : null;
          L.mediaName = mm ? mm.name : null;
          commit();
        } },
      el("option", { value: "" }, "— aucun —"),
      media.map((x) => el("option", { value: x.id, selected: x.id === L.mediaId }, (x.kind === "video" ? "🎞 " : "🖼 ") + x.name))
    );
    if (L.mediaId && !m) mediaSel.prepend(el("option", { value: L.mediaId, selected: true }, "⚠ " + (L.mediaName || "manquant")));

    const opVal = el("span", { class: "val" }, Math.round(L.opacity * 100) + "%");
    const featherVal = el("span", { class: "val" }, Math.round((L.feather || 0) * 200) + "%");
    const volVal = el("span", { class: "val" }, Math.round(L.volume * 100) + "%");

    const g = el(
      "div",
      { class: "props" },
      el("label", {}, "Nom"),
      el("input", { type: "text", value: L.name, oninput: (e) => { L.name = e.target.value; saveSoon(); chan.send({ type: "state", state }); renderLayers(); } }),

      el("label", {}, "Forme"),
      el("div", { class: "row" }, shapeSelect(L)),
      el("p", { class: "hint full" }, L.shape === "poly"
        ? "Polygone : la forme découpe le média (masque). Glissez ses sommets sur la scène."
        : L.shape === "circle"
        ? "Cercle : calez les 4 coins du carré qui entoure le disque réel ; le média est découpé en ellipse et suit la perspective."
        : "Rectangle : le média est déformé en perspective pour suivre les 4 coins."),
      L.shape === "circle" ? [
        el("label", {}, "Bord doux"),
        el("div", { class: "row" },
          el("input", { type: "range", min: 0, max: 0.5, step: 0.01, value: L.feather || 0, style: "flex:1",
            oninput: (e) => { L.feather = +e.target.value; featherVal.textContent = Math.round(L.feather * 200) + "%"; commit({ props: false }); } }),
          featherVal),
      ] : null,

      el("label", {}, "Média"),
      el("div", { class: "row" }, mediaSel, el("label", { class: "btn small", title: "Importer un fichier pour ce calque" }, "…", el("input", {
        type: "file", accept: "video/*,image/*,.webm,.mov,.mp4", hidden: true,
        onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const rec = await VM.putMedia(f);
            L.mediaId = rec.id;
            L.mediaName = rec.name;
            await refreshMedia();
            commit();
          } catch (err) { toast(err.message); }
        } }))),

      L.mediaId ? [
        el("label", {}, "Cadrage"),
        el("div", { class: "row" },
          el("select", { title: "Comment le média remplit la forme", onchange: (e) => { L.fit = e.target.value; commit({ props: false }); } },
            [["stretch", "Étirer à la forme"], ["cover", "Remplir (rogner)"], ["contain", "Ajuster (bandes vides)"]].map(([v, t]) =>
              el("option", { value: v, selected: (L.fit || "stretch") === v }, t))),
          el("button", { class: "small", title: "Remet le média au centre, sans zoom ni rotation", onclick: () => { L.frame = { x: 0, y: 0, zoom: 1, rot: 0 }; commit(); } }, "Recentrer")
        ),
        frameSlider(L, "x", "↔ X", -1, 1, 0.005, (v) => Math.round(v * 100) + "%"),
        frameSlider(L, "y", "↕ Y", -1, 1, 0.005, (v) => Math.round(v * 100) + "%"),
        frameSlider(L, "zoom", "Zoom", 0.1, 4, 0.01, (v) => Math.round(v * 100) + "%"),
        frameSlider(L, "rot", "Rotation", -180, 180, 1, (v) => Math.round(v) + "°"),
        el("p", { class: "hint full" }, "À la souris : mode « Cadrer le média » (glisser, molette, Maj + molette)."),
      ] : null,

      el("label", {}, "Affichage"),
      el("div", { class: "row" },
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: L.visible, onchange: (e) => { L.fade = null; set("visible", e.target.checked); } }), "visible"),
        el("button", { class: "small", onclick: () => run({ action: "fadein", layerId: L.id, param: 2 }) }, "Fondu ↗"),
        el("button", { class: "small", onclick: () => run({ action: "fadeout", layerId: L.id, param: 2 }) }, "Fondu ↘"),
        el("button", { class: "small", onclick: () => run({ action: "solo", layerId: L.id }) }, "Solo")
      ),

      el("label", {}, "Opacité"),
      el("div", { class: "row" }, el("input", { type: "range", min: 0, max: 1, step: 0.01, value: L.opacity, style: "flex:1",
        oninput: (e) => { L.fade = null; L.opacity = +e.target.value; opVal.textContent = Math.round(L.opacity * 100) + "%"; commit({ props: false }); } }), opVal),

      isVideo ? [
        el("label", {}, "Lecture"),
        el("div", { class: "row" },
          el("button", { class: "small", onclick: () => run({ action: "playpause", layerId: L.id }) }, L.playing ? "❚❚ Pause" : "▶ Lire"),
          el("button", { class: "small", onclick: () => run({ action: "restart", layerId: L.id }) }, "⏮ Début"),
          el("label", { class: "check" }, el("input", { type: "checkbox", checked: L.loop, onchange: (e) => set("loop", e.target.checked) }), "en boucle")
        ),
        el("label", {}, "Vitesse"),
        el("select", { onchange: (e) => set("rate", +e.target.value) },
          [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => el("option", { value: r, selected: r === L.rate }, "× " + r))),
        el("label", {}, "Son"),
        el("div", { class: "row" },
          el("label", { class: "check" }, el("input", { type: "checkbox", checked: L.muted, onchange: (e) => set("muted", e.target.checked) }), "muet"),
          el("input", { type: "range", min: 0, max: 1, step: 0.01, value: L.volume, style: "flex:1", disabled: L.muted,
            oninput: (e) => { L.volume = +e.target.value; volVal.textContent = Math.round(L.volume * 100) + "%"; commit({ props: false, render: false }); } }),
          volVal
        ),
        el("p", { class: "hint full" }, "Le son est joué uniquement par l'écran de sortie ; l'aperçu d'édition reste muet."),
      ] : null,

      el("label", {}, "Repère"),
      el("div", { class: "row" },
        el("input", { type: "color", value: L.color, oninput: (e) => { L.color = e.target.value; commit({ props: false }); } }),
        el("button", { class: "small", title: "Remet la surface au centre, sans déformation", onclick: () => {
          L.surface = engine.resetSurface(L.id);
          commit({ props: false });
        } }, "Réinitialiser la surface"),
        L.shape !== "quad" && L.shape ? null : el("button", { class: "small", title: "Redonne à la surface un rectangle aux proportions du média (le calage est perdu)", disabled: !(mediaStatus[L.id] && mediaStatus[L.id].aspect), onclick: () => {
          L.aspect = mediaStatus[L.id].aspect;
          L.surface = engine.resetSurface(L.id);
          commit({ props: false });
        } }, "Proportions du média")
      ),

      el("label", {}, "Calque"),
      el("div", { class: "row" },
        el("button", { class: "small", onclick: () => {
          const c = VM.newLayer(state, JSON.parse(JSON.stringify(L)));
          c.id = VM.uid("layer");
          c.name = L.name + " (copie)";
          const i = state.layers.indexOf(L);
          state.layers.splice(i + 1, 0, c);
          selectedId = c.id;
          commit();
        } }, "Dupliquer"),
        el("button", { class: "small", onclick: () => {
          if (!confirm("Supprimer le calque « " + L.name + " » ?")) return;
          state.layers = state.layers.filter((x) => x.id !== L.id);
          state.bindings = state.bindings.filter((b) => b.layerId !== L.id || !VM.ACTIONS[b.action].layer);
          selectedId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
          commit({ bindings: true });
        } }, "Supprimer")
      )
    );
    box.append(g);
  }

  function renderBindings() {
    const box = $("#bindings");
    box.innerHTML = "";
    if (!state.bindings.length) {
      box.append(el("p", { class: "empty" }, "Aucun raccourci. Ex. : Espace = tout lire/pause, 1 = fondu entrant du calque 1…"));
      return;
    }
    for (const b of state.bindings) {
      const def = VM.ACTIONS[b.action] || {};
      const row = el(
        "div",
        { class: "binding" },
        el("button", {
          class: "keycap" + (listeningBinding === b.id ? " listening" : ""),
          "data-key": b.key,
          title: "Cliquez puis appuyez sur une touche",
          onclick: () => { listeningBinding = b.id; renderBindings(); },
        }, listeningBinding === b.id ? "…" : b.key ? VM.keyLabel(b.key) : "?"),
        el("div", { class: "cfg" },
          el("select", { onchange: (e) => {
              b.action = e.target.value;
              const d = VM.ACTIONS[b.action];
              if (d.param && !b.param) b.param = d.def;
              commit({ bindings: true, props: false });
            } },
            Object.entries(VM.ACTIONS).map(([k, a]) => el("option", { value: k, selected: k === b.action }, a.label))),
          def.layer || def.param ? el("div", { class: "line" },
            def.layer ? el("select", { onchange: (e) => { b.layerId = e.target.value; commit({ props: false, render: false }); saveSoon(); } },
              el("option", { value: "" }, "— calque —"),
              [...state.layers].reverse().map((l) => el("option", { value: l.id, selected: l.id === b.layerId }, l.name))) : null,
            def.param ? el("input", { type: "number", min: 0.1, step: 0.1, value: b.param ?? def.def, title: def.param,
              onchange: (e) => { b.param = +e.target.value; commit({ props: false, render: false }); } }) : null
          ) : null
        ),
        el("button", { class: "icon", title: "Supprimer", onclick: () => {
          state.bindings = state.bindings.filter((x) => x !== b);
          commit({ bindings: true, props: false });
        } }, "✕")
      );
      box.append(row);
    }
  }

  function renderMedia() {
    const ul = $("#mediaList");
    ul.innerHTML = "";
    if (!media.length) {
      ul.append(el("li", { class: "empty" }, "Vide."));
      return;
    }
    const S = selected();
    for (const m of media) {
      const used = state.layers.filter((l) => l.mediaId === m.id).length;
      ul.append(
        el("li", { class: "media-item", draggable: "true", title: "Glissez sur une forme (scène ou liste des calques)",
            ondragstart: (e) => {
              e.dataTransfer.setData(MEDIA_MIME, m.id);
              e.dataTransfer.effectAllowed = "copy";
            } },
          el("div", {}, el("b", {}, (m.kind === "video" ? "🎞 " : "🖼 ") + m.name),
            el("small", {}, (m.size / 1048576).toFixed(1) + " Mo" + (used ? " · " + used + " calque(s)" : ""))),
          el("div", { class: "tools" },
            el("button", { class: "small", title: S ? "Mettre ce média dans la forme " + layerTitle(S) : "Sélectionnez d'abord un calque", disabled: !S, onclick: () => assignMedia(S, m) }, "→ forme"),
            el("button", { class: "small", title: "Nouveau calque avec ce média", onclick: async () => {
              const L = VM.newLayer(state, { name: m.name.replace(/\.[^.]+$/, ""), mediaId: m.id, mediaName: m.name, autoAspect: true });
              state.layers.push(L);
              selectedId = L.id;
              commit();
            } }, "+ calque"),
            el("button", { class: "icon", title: "Supprimer de la médiathèque", onclick: async () => {
              if (used && !confirm("Ce média est utilisé par " + used + " calque(s). Le supprimer quand même ?")) return;
              await VM.deleteMedia(m.id);
              state.layers.forEach((l) => { if (l.mediaId === m.id) l.mediaId = null; });
              await refreshMedia();
              commit();
            } }, "✕"))
        )
      );
    }
  }

  /* ---------------------------- Depuis une photo ------------------------- */

  $("#btnPhoto").onclick = () => {
    VM.openPhotoTool({
      getState: () => state,
      toast,
      setTestPattern(kind) {
        state.testPattern = kind;
        commit({ props: false });
      },
      addLayers(list, backdrop) {
        for (const d of list) {
          const L = VM.newLayer(state, d);
          state.layers.push(L);
          selectedId = L.id;
        }
        if (backdrop) state.backdrop = backdrop;
        state.testPattern = null;
        state.calibrate = true;
        commit();
        toast(list.length + " forme(s) créée(s) — glissez un média sur chacune (scène, liste ou médiathèque)");
      },
    });
  };

  $("#selPattern").addEventListener("change", (e) => {
    state.testPattern = e.target.value || null;
    commit({ props: false });
  });
  $("#chkBackdrop").addEventListener("change", (e) => {
    if (!state.backdrop) return;
    state.backdrop.show = e.target.checked;
    commit({ props: false });
  });
  $("#rngBackdrop").addEventListener("input", (e) => {
    if (!state.backdrop) return;
    state.backdrop.opacity = +e.target.value;
    saveSoon();
  });
  $("#btnBackdropDel").onclick = () => {
    if (!state.backdrop) return;
    VM.deleteMedia(state.backdrop.mediaId).catch(() => {});
    state.backdrop = null;
    commit({ props: false });
  };

  $("#btnAddLayer").onclick = () => {
    const L = VM.newLayer(state);
    state.layers.push(L);
    selectedId = L.id;
    commit();
  };

  /* ---------------------------------- Init -------------------------------- */

  renderTop();
  renderLayers();
  renderProps();
  renderBindings();
  refreshMedia().then(() => renderLayers());
  chan.send({ type: "state", state });

  // exposé pour le débogage dans la console
  window.vmEditor = { get state() { return state; }, engine, commit };
})();
