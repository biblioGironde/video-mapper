/* =========================================================================
 * Video Mapper — moteur de rendu (p5.js 2 + p5.mapper)
 * Utilisé à la fois par l'écran d'édition et par l'écran de sortie.
 * ========================================================================= */
(function () {
  const VM = (window.VM = window.VM || {});

  /**
   * @param {HTMLElement} container
   * @param {object} opts
   *   role: "editor" | "output"
   *   getState(): état courant
   *   onSurfaceChange(layerId, json)   (éditeur) coins déplacés
   *   onSelectLayer(layerId)           (éditeur) clic sur une surface
   *   onMediaStatus(layerId, status)   statut média (prêt, manquant, son bloqué…)
   *   fit: fonction (canvas) -> ajuste la taille CSS du canvas
   */
  VM.createEngine = (container, opts) => {
    const role = opts.role;
    const layers = new Map(); // id -> {quad, media, mediaId, lastJSON}
    const mediaCache = new Map(); // mediaId -> Promise<{url, rec}>
    let p, pMapper;
    let ready = false;
    let lastSelected = null;
    let audioBlocked = false;

    const engine = {
      ready: () => ready,
      get p() {
        return p;
      },
      get pMapper() {
        return pMapper;
      },
      sync,
      restart,
      times,
      applyTimes,
      resetSurface,
      setSurfaceJSON,
      unlockAudio,
      isAudioBlocked: () => audioBlocked,
      layerInfo: (id) => layers.get(id),
      layerAt,
      outline,
      ellipsePoly,
      uvAt,
      setHighlight: (id) => (highlightId = id),
    };
    let highlightId = null;

    /* ------------------------------ Sketch p5 ----------------------------- */

    new p5((sk) => {
      p = sk;
      sk.setup = () => {
        const st = opts.getState().stage;
        sk.pixelDensity(1);
        const c = sk.createCanvas(st.w, st.h, sk.WEBGL);
        c.parent(container);
        pMapper = sk.createProjectionMapper(sk);
        watchContextLoss(c.elt);
        // Le calque de calibration de p5.mapper redessine à chaque image une grille
        // 2D plein écran (≈400 cellules par surface) puis l'envoie au GPU : lent et
        // source de scintillement pendant les glisser. On le remplace par un tracé
        // WebGL léger (drawGuides) ; la saisie des points reste celle de p5.mapper.
        pMapper.getCalibSharedGfx = () => null;
        pMapper.beginCalibFrame = () => {};
        pMapper.blitCalibSharedGfx = () => {};
        if (role === "output") {
          // la sortie ne doit jamais modifier la calibration à la souris
          pMapper.updateEvents = () => {};
        }
        ready = true;
        opts.fit && opts.fit(c.elt);
        sync();
      };

      sk.draw = () => {
        const state = opts.getState();
        sk.background(0);
        sk.textureMode(sk.NORMAL);

        // calibration : éditeur = selon l'option ; sortie = selon « repères »
        if (role === "editor") pMapper.calibrate = !!state.calibrate;
        else pMapper.calibrate = !!state.showGuides;

        // photo de repérage redressée, en fond de l'éditeur
        if (role === "editor" && state.backdrop && state.backdrop.show) drawBackdrop(state);

        const now = Date.now();
        for (const L of state.layers) {
          const ent = layers.get(L.id);
          if (!ent) continue;
          const op = state.blackout ? 0 : VM.effectiveOpacity(L, now);
          const tex = ent.media && ent.media.ready ? ent.media.tex : null;
          const guides = pMapper.calibrate;

          const circle = L.shape === "circle";
          if (op > 0.001 && tex) {
            sk.tint(255, Math.round(op * 255));
            ent.quad.displayTexture(needsCompose(L) ? composeTex(ent, tex, L) : tex);
            sk.noTint();
          } else if (guides) {
            // calque sans média (ou masqué) : aplat translucide pour le repérer
            const c = sk.color(L.color);
            c.setAlpha(tex ? 40 : 90);
            if (circle) fillPoly(ellipsePoly(L.id), c);
            else ent.quad.display(c);
          }
        }

        if (pMapper.calibrate) drawGuides(state);

        if (state.testPattern) drawTestPattern(state.testPattern);

        // forme visée pendant un glisser-déposer de média
        if (highlightId) {
          const HL = state.layers.find((x) => x.id === highlightId);
          const poly = HL && HL.shape === "circle" ? ellipsePoly(highlightId) : outline(highlightId);
          if (poly) {
            sk.push();
            sk.translate(0, 0, 3);
            sk.noFill();
            sk.stroke(94, 230, 196);
            sk.strokeWeight(10);
            sk.beginShape();
            poly.forEach((q) => sk.vertex(q.x, q.y));
            sk.endShape(sk.CLOSE);
            sk.fill(94, 230, 196, 50);
            sk.noStroke();
            sk.beginShape();
            poly.forEach((q) => sk.vertex(q.x, q.y));
            sk.endShape(sk.CLOSE);
            sk.pop();
          }
        }

        if (role === "editor") {
          trackEdits(state);
        }
      };
    }, container);

    /* ------------------------------- Cercles ------------------------------- */

    /**
     * Cadrage du média dans sa forme : ajustement (étirer / remplir / ajuster),
     * décalage, zoom, rotation, puis découpe en ellipse pour les cercles.
     * Le média est composé dans un tampon 2D carré qui est ensuite plaqué sur la
     * forme (son espace UV) : le cadrage suit donc la perspective de la forme.
     * Sans cadrage ni découpe, la texture est plaquée directement (plus rapide).
     */
    const frameOf = (L) => Object.assign({ x: 0, y: 0, zoom: 1, rot: 0 }, L.frame || {});

    function needsCompose(L) {
      const f = frameOf(L);
      return L.shape === "circle" || (L.fit && L.fit !== "stretch") || f.x || f.y || f.zoom !== 1 || f.rot;
    }

    /** Proportions de la forme telle qu'on la voit (largeur / hauteur). */
    function frameAspect(L) {
      const o = outline(L.id);
      if (!o) return 1;
      if (L.shape === "poly" || o.length !== 4) {
        const xs = o.map((q) => q.x), ys = o.map((q) => q.y);
        return Math.max(1, Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.max(...ys) - Math.min(...ys));
      }
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      return (d(o[0], o[1]) + d(o[3], o[2])) / Math.max(1, d(o[0], o[3]) + d(o[1], o[2]));
    }

    function composeTex(ent, tex, L) {
      const isVideo = ent.media && ent.media.kind === "video";
      const src = isVideo ? tex.elt : tex.canvas || tex.elt;
      const sw = tex.width, sh = tex.height;
      if (!src || !sw || !sh) return tex;
      const n = Math.max(64, Math.min(1280, Math.max(sw, sh)));
      let m = ent.comp;
      if (!m || m.n !== n) {
        if (m) m.g.remove();
        const g = p.createGraphics(n, n);
        g.pixelDensity(1);
        m = ent.comp = { g, n, key: null };
      }
      // proportions arrondies : pas de recomposition à chaque pixel de glisser
      const asp = Math.round(frameAspect(L) * 50) / 50;
      const fr = frameOf(L);
      const fit = L.fit || "stretch";
      const key = [ent.mediaId, fit, fr.x, fr.y, fr.zoom, fr.rot, asp, L.shape, L.feather || 0].join("|");
      if (!isVideo && m.key === key) return m.g; // image fixe : composée une seule fois par réglage
      // espace « virtuel » aux proportions de la forme, ramené au tampon carré
      const vh = 1000, vw = 1000 * asp;
      const ctx = m.g.drawingContext;
      ctx.save();
      ctx.setTransform(n / vw, 0, 0, n / vh, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      ctx.translate(vw / 2 + fr.x * vw, vh / 2 + fr.y * vh);
      ctx.rotate((fr.rot * Math.PI) / 180);
      let sx, sy;
      if (fit === "stretch") {
        sx = (vw / sw) * fr.zoom;
        sy = (vh / sh) * fr.zoom;
      } else {
        const base = fit === "cover" ? Math.max(vw / sw, vh / sh) : Math.min(vw / sw, vh / sh);
        sx = sy = base * fr.zoom;
      }
      ctx.scale(sx, sy);
      ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
      if (L.shape === "circle") {
        const feather = L.feather || 0;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.translate(n / 2, n / 2);
        ctx.scale(n / 2, n / 2);
        if (feather > 0) {
          const gr = ctx.createRadialGradient(0, 0, Math.max(0, 1 - feather), 0, 0, 1);
          gr.addColorStop(0, "rgba(0,0,0,1)");
          gr.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = gr;
        } else ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      m.key = key;
      return m.g;
    }

    /** Homographie qui envoie src[i] sur dst[i] (4 points), renvoyée comme fonction. */
    function solveH(srcPts, dstPts) {
      const A = [], b = [];
      for (let i = 0; i < 4; i++) {
        const x = srcPts[i].x, y = srcPts[i].y, u = dstPts[i].x, v = dstPts[i].y;
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
      }
      for (let col = 0; col < 8; col++) {
        let piv = col;
        for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        [A[col], A[piv]] = [A[piv], A[col]];
        [b[col], b[piv]] = [b[piv], b[col]];
        for (let r = 0; r < 8; r++) {
          if (r === col || !A[col][col]) continue;
          const f = A[r][col] / A[col][col];
          for (let kk = col; kk < 8; kk++) A[r][kk] -= f * A[col][kk];
          b[r] -= f * b[col];
        }
      }
      const H = b.map((v, i) => v / A[i][i]).concat(1);
      return (x, y) => {
        const w = H[6] * x + H[7] * y + H[8];
        return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
      };
    }
    const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const unitHomography = (c) => solveH(UNIT, c);

    /** Point écran → coordonnées (u, v) dans l'espace du média de la forme (0..1). */
    function uvAt(id, clientX, clientY) {
      const L = opts.getState().layers.find((x) => x.id === id);
      const o = outline(id);
      if (!L || !o) return null;
      const r = p.canvas.getBoundingClientRect();
      const pt = { x: ((clientX - r.left) / r.width) * p.width - p.width / 2, y: ((clientY - r.top) / r.height) * p.height - p.height / 2 };
      if (L.shape === "poly" || o.length !== 4) {
        const xs = o.map((q) => q.x), ys = o.map((q) => q.y);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        const q = { x: (pt.x - x0) / Math.max(1, Math.max(...xs) - x0), y: (pt.y - y0) / Math.max(1, Math.max(...ys) - y0) };
        return { u: q.x, v: q.y };
      }
      const q = solveH(o, UNIT)(pt.x, pt.y);
      return { u: q.x, v: q.y };
    }

    /** Contour de l'ellipse inscrite (en perspective) d'un calque cercle. */
    function ellipsePoly(id, n = 72) {
      const q = outline(id);
      if (!q || q.length !== 4) return q;
      const f = unitHomography(q);
      return Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return f(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
      });
    }

    function fillPoly(poly, c) {
      if (!poly) return;
      p.push();
      p.noStroke();
      p.fill(c);
      p.beginShape();
      poly.forEach((v) => p.vertex(v.x, v.y));
      p.endShape(p.CLOSE);
      p.pop();
    }

    /* ------------------------- Repères de calibration ---------------------- */

    function drawGuides(state) {
      const sel = opts.getSelectedId ? opts.getSelectedId() : null;
      const p = engine.p;
      p.push();
      p.translate(0, 0, 2);
      p.noFill();
      for (const L of state.layers) {
        const ent = layers.get(L.id);
        if (!ent) continue;
        const poly = outline(L.id);
        if (!poly) continue;
        const c = p.color(L.color);
        const isSel = L.id === sel;
        // grille de perspective légère (4 × 4) pour les quadrilatères
        const q = ent.quad;
        if (q.mesh && q.resX > 4) {
          c.setAlpha(isSel ? 150 : 90);
          p.stroke(c);
          p.strokeWeight(1);
          const nx = q.resX,
            ny = q.resY || q.resX;
          const at = (gx, gy) => q.mesh[gy * nx + gx];
          const lines = (count, len, pt) => {
            for (let k = 1; k < 4; k++) {
              const g = Math.round((k * (count - 1)) / 4);
              p.beginShape();
              for (let t = 0; t < len; t++) {
                const m = pt(g, t);
                if (m) p.vertex(m.x + q.x, m.y + q.y);
              }
              p.endShape();
            }
          };
          lines(nx, ny, (g, t) => at(g, t)); // verticales
          lines(ny, nx, (g, t) => at(t, g)); // horizontales
        }
        const isCircle = L.shape === "circle";
        c.setAlpha(isCircle ? 140 : 255);
        p.stroke(c);
        p.strokeWeight(isCircle ? 1.5 : isSel ? 5 : 2);
        p.beginShape();
        poly.forEach((v) => p.vertex(v.x, v.y));
        p.endShape(p.CLOSE);
        if (isCircle) {
          c.setAlpha(255);
          p.stroke(c);
          p.strokeWeight(isSel ? 5 : 2);
          p.beginShape();
          ellipsePoly(L.id).forEach((v) => p.vertex(v.x, v.y));
          p.endShape(p.CLOSE);
        }
      }
      p.pop();
    }

    /* ------------------------- Fond photo & mires -------------------------- */

    let backdrop = { id: null, img: null };
    function drawBackdrop(state) {
      const b = state.backdrop;
      if (backdrop.id !== b.mediaId) {
        backdrop = { id: b.mediaId, img: null };
        const want = b.mediaId;
        getMediaURL(b.mediaId).then(async (got) => {
          if (!got || backdrop.id !== want) return;
          const img = await p.loadImage(got.url);
          if (backdrop.id === want) backdrop.img = img;
        });
      }
      if (!backdrop.img) return;
      p.push();
      p.tint(255, Math.round((b.opacity ?? 0.5) * 255));
      p.image(backdrop.img, -p.width / 2, -p.height / 2, p.width, p.height);
      p.pop();
    }

    function drawTestPattern(kind) {
      const w = p.width,
        h = p.height;
      p.push();
      p.translate(-w / 2, -h / 2, 1);
      p.noStroke();
      if (kind === "white") {
        p.fill(255);
        p.rect(0, 0, w, h);
      } else {
        p.fill(0);
        p.rect(0, 0, w, h);
        p.stroke(255);
        p.strokeWeight(1);
        p.noFill();
        const n = 16;
        for (let i = 1; i < n; i++) {
          p.line((i * w) / n, 0, (i * w) / n, h);
          p.line(0, (i * h) / n, w, (i * h) / n);
        }
        p.strokeWeight(4);
        p.rect(2, 2, w - 4, h - 4);
        p.line(0, 0, w, h);
        p.line(w, 0, 0, h);
        p.ellipse(w / 2, h / 2, h * 0.5, h * 0.5);
      }
      p.pop();
    }

    /* ------------------------ Création / suppression ----------------------- */

    function createQuad(L) {
      if (L.shape === "poly" && L.polyCount >= 3) {
        // polygone libre (p5.mapper PolyMap) : texture plaquée sur sa boîte englobante
        const q = pMapper.createPolyMap(L.polyCount);
        q.x = -200;
        q.y = -200;
        if (L.surface) {
          try {
            q.load(L.surface);
          } catch (e) {
            console.warn("Forme illisible pour", L.name, e);
          }
        }
        return q;
      }
      const st = opts.getState().stage;
      let w = st.w * 0.5;
      let h = w / (L.aspect || 16 / 9);
      if (h > st.h * 0.6) {
        h = st.h * 0.6;
        w = h * (L.aspect || 16 / 9);
      }
      const q = pMapper.createQuadMap(Math.round(w), Math.round(h), VM.QUAD_RES, VM.QUAD_RES);
      q.x = -Math.round(w / 2);
      q.y = -Math.round(h / 2);
      if (L.surface) {
        try {
          q.load(L.surface);
        } catch (e) {
          console.warn("Calibration illisible pour", L.name, e);
        }
      }
      if (q.calculateMesh) q.calculateMesh();
      return q;
    }

    function removeQuad(q) {
      const i = pMapper.surfaces.indexOf(q);
      if (i >= 0) pMapper.surfaces.splice(i, 1);
    }

    function resetSurface(layerId) {
      const ent = layers.get(layerId);
      if (!ent) return;
      const L = opts.getState().layers.find((l) => l.id === layerId);
      removeQuad(ent.quad);
      ent.quad = createQuad(Object.assign({}, L, { surface: null }));
      ent.lastJSON = JSON.stringify(ent.quad.toJSON());
      reorder(opts.getState());
      return ent.quad.toJSON();
    }

    function setSurfaceJSON(layerId, json) {
      const ent = layers.get(layerId);
      if (!ent || !json) return;
      const s = JSON.stringify(json);
      if (s === ent.lastJSON) return;
      const q = ent.quad;
      if (json.type === "POLY" && q.points && json.points && q.points.length === json.points.length) {
        // mise à jour en place : PolyMap.load() recrée un tampon graphique à chaque
        // changement de taille, ce qui saturait la sortie pendant un glisser
        q.x = json.x;
        q.y = json.y;
        json.points.forEach((pt) => {
          const mp = q.points[pt.i];
          if (mp) {
            mp.x = pt.x;
            mp.y = pt.y;
          }
        });
      } else {
        q.load(json);
      }
      ent.lastJSON = s;
    }

    function reorder(state) {
      // l'ordre des surfaces dans p5.mapper = ordre des calques
      const ordered = [];
      for (const L of state.layers) {
        const e = layers.get(L.id);
        if (e) ordered.push(e.quad);
      }
      pMapper.surfaces.length = 0;
      ordered.forEach((q) => pMapper.surfaces.push(q));
    }

    /* ------------------------------- Médias -------------------------------- */

    function getMediaURL(mediaId) {
      if (!mediaCache.has(mediaId)) {
        mediaCache.set(
          mediaId,
          VM.getMedia(mediaId).then((rec) => (rec ? { url: URL.createObjectURL(rec.blob), rec } : null))
        );
      }
      return mediaCache.get(mediaId);
    }

    function disposeMedia(m) {
      if (!m) return;
      m.disposed = true;
      if (m.kind === "video" && m.tex) {
        try {
          m.tex.elt.pause();
          m.tex.remove();
        } catch (e) {}
      }
    }

    async function attachMedia(L, ent) {
      disposeMedia(ent.media);
      ent.media = null;
      ent.mediaId = L.mediaId;
      if (!L.mediaId) return;
      const token = {};
      ent.loadToken = token;
      const got = await getMediaURL(L.mediaId);
      if (ent.loadToken !== token) return;
      if (!got) {
        opts.onMediaStatus && opts.onMediaStatus(L.id, "missing");
        return;
      }
      const { url, rec } = got;
      const m = { kind: rec.kind, ready: false, tex: null };
      ent.media = m;

      if (rec.kind === "video") {
        const v = p.createVideo(url);
        v.hide();
        const el = v.elt;
        el.playsInline = true;
        el.preload = "auto";
        el.crossOrigin = "anonymous";
        m.tex = v;
        el.addEventListener("loadeddata", () => {
          if (m.disposed) return;
          // p5 lit width/height sur l'élément : on les renseigne explicitement
          v.width = el.videoWidth;
          v.height = el.videoHeight;
          m.ready = true;
          m.aspect = el.videoWidth / el.videoHeight;
          opts.onMediaStatus && opts.onMediaStatus(L.id, "ready", { aspect: m.aspect, duration: el.duration });
          applyPlayback(opts.getState().layers.find((x) => x.id === L.id), ent);
        });
        el.addEventListener("error", () => opts.onMediaStatus && opts.onMediaStatus(L.id, "error"));
        el.addEventListener("ended", () => {
          const cur = opts.getState().layers.find((x) => x.id === L.id);
          if (cur && !cur.loop && opts.onEnded) opts.onEnded(L.id);
        });
      } else {
        const img = await p.loadImage(url);
        if (m.disposed) return;
        m.tex = img;
        m.ready = true;
        m.aspect = img.width / img.height;
        opts.onMediaStatus && opts.onMediaStatus(L.id, "ready", { aspect: m.aspect });
      }
    }

    function applyPlayback(L, ent) {
      if (!L || !ent || !ent.media || ent.media.kind !== "video" || !ent.media.ready) return;
      const el = ent.media.tex.elt;
      el.loop = !!L.loop;
      el.playbackRate = L.rate || 1;
      // l'éditeur est toujours muet : le son sort de l'écran de projection
      const wantMuted = role === "editor" ? true : !!L.muted;
      el.volume = Math.max(0, Math.min(1, L.volume ?? 1));
      if (!audioBlocked || wantMuted) el.muted = wantMuted;
      const wantPlay = L.playing && !(el.ended && !L.loop);
      if (wantPlay && el.paused) {
        const pr = el.play();
        if (pr && pr.catch) {
          pr.catch((err) => {
            if (err && err.name === "NotAllowedError" && !el.muted) {
              // lecture avec son refusée sans geste utilisateur : on joue muet en attendant
              audioBlocked = true;
              el.muted = true;
              el.play().catch(() => {});
              opts.onMediaStatus && opts.onMediaStatus(L.id, "audio-blocked");
            }
          });
        }
      } else if (!L.playing && !el.paused) {
        el.pause();
      }
    }

    function unlockAudio() {
      audioBlocked = false;
      const state = opts.getState();
      for (const L of state.layers) {
        const ent = layers.get(L.id);
        if (ent && ent.media && ent.media.kind === "video" && ent.media.ready) {
          ent.media.tex.elt.muted = role === "editor" ? true : !!L.muted;
          applyPlayback(L, ent);
        }
      }
    }

    /* ------------------------------ Synchro -------------------------------- */

    function sync() {
      if (!ready) return;
      const state = opts.getState();

      if (p.width !== state.stage.w || p.height !== state.stage.h) {
        p.resizeCanvas(state.stage.w, state.stage.h);
        opts.fit && opts.fit(p.canvas);
      }

      const ids = new Set(state.layers.map((l) => l.id));
      for (const [id, ent] of layers) {
        if (!ids.has(id)) {
          removeQuad(ent.quad);
          disposeMedia(ent.media);
          if (ent.comp) ent.comp.g.remove();
          layers.delete(id);
        }
      }
      for (const L of state.layers) {
        let ent = layers.get(L.id);
        const shapeKey = (L.shape || "quad") + ":" + (L.polyCount || 0);
        if (ent && ent.shapeKey !== shapeKey) {
          // la forme du calque a changé de nature (rectangle ↔ polygone) : on la reconstruit
          removeQuad(ent.quad);
          ent.quad = createQuad(L);
          ent.lastJSON = JSON.stringify(ent.quad.toJSON());
          ent.shapeKey = shapeKey;
        }
        if (!ent) {
          ent = { quad: createQuad(L), media: null, mediaId: undefined, shapeKey };
          ent.lastJSON = JSON.stringify(ent.quad.toJSON());
          layers.set(L.id, ent);
          // l'éditeur enregistre tout de suite la position initiale de la surface
          if (role === "editor" && !L.surface && opts.onSurfaceChange) {
            opts.onSurfaceChange(L.id, JSON.parse(ent.lastJSON), false);
          }
        } else if (L.surface) {
          setSurfaceJSON(L.id, L.surface);
        }
        if (ent.mediaId !== L.mediaId) attachMedia(L, ent);
        applyPlayback(L, ent);
      }
      reorder(state);
    }

    /** Contour d'un calque en coordonnées scène centrées (polygone fermé). */
    function outline(id) {
      const ent = layers.get(id);
      if (!ent) return null;
      const j = ent.quad.toJSON();
      const pts = j.points || [];
      if (j.type === "POLY") return pts.map((q) => ({ x: q.x + j.x, y: q.y + j.y }));
      const rx = j.res || VM.QUAD_RES,
        ry = j.resY || rx;
      const at = (i) => {
        const q = pts.find((z) => z.i === i);
        return q ? { x: q.x + j.x, y: q.y + j.y } : null;
      };
      const c = [at(0), at(rx - 1), at(rx * ry - 1), at(rx * (ry - 1))];
      return c.every(Boolean) ? c : null;
    }

    /** Calque visible sous un point écran (le plus haut d'abord), ou null. */
    function layerAt(clientX, clientY) {
      if (!ready) return null;
      const r = p.canvas.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
      const pt = { x: ((clientX - r.left) / r.width) * p.width - p.width / 2, y: ((clientY - r.top) / r.height) * p.height - p.height / 2 };
      const ls = opts.getState().layers;
      for (let i = ls.length - 1; i >= 0; i--) {
        const poly = ls[i].shape === "circle" ? ellipsePoly(ls[i].id) : outline(ls[i].id);
        if (poly && insidePoly(pt, poly)) return ls[i].id;
      }
      return null;
    }

    function insidePoly(pt, poly) {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i],
          b = poly[j];
        if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    }

    function restart(id) {
      const ent = layers.get(id);
      if (ent && ent.media && ent.media.kind === "video") {
        const el = ent.media.tex.elt;
        el.currentTime = 0;
        const L = opts.getState().layers.find((x) => x.id === id);
        applyPlayback(L, ent);
      }
    }

    /** Positions de lecture (la sortie est l'horloge de référence). */
    function times() {
      const out = {};
      for (const [id, ent] of layers) {
        if (ent.media && ent.media.kind === "video" && ent.media.ready) {
          out[id] = ent.media.tex.elt.currentTime;
        }
      }
      return out;
    }

    function applyTimes(t) {
      for (const id in t) {
        const ent = layers.get(id);
        if (!ent || !ent.media || ent.media.kind !== "video" || !ent.media.ready) continue;
        const el = ent.media.tex.elt;
        const d = Math.abs(el.currentTime - t[id]);
        const dur = el.duration || 0;
        if (d > 0.35 && !(dur && d > dur - 0.5)) el.currentTime = t[id];
      }
    }

    /* ------------------- Éditeur : détection des retouches ------------------ */

    let lastEmit = 0;
    function trackEdits(state) {
      // sélection d'une surface au clic
      const sel = pMapper.selected;
      if (sel !== lastSelected) {
        lastSelected = sel;
        if (sel) {
          for (const [id, ent] of layers) if (ent.quad === sel && opts.onSelectLayer) opts.onSelectLayer(id);
        }
      }
      if (!pMapper.calibrate) return;
      const now = performance.now();
      const dragging = p.mouseIsPressed;
      // pendant un glisser : ~30 envois / s ; sinon on vérifie quand même (chargement…)
      if (dragging && now - lastEmit < 33) return;
      lastEmit = now;
      for (const [id, ent] of layers) {
        const s = JSON.stringify(ent.quad.toJSON());
        if (s !== ent.lastJSON) {
          ent.lastJSON = s;
          opts.onSurfaceChange && opts.onSurfaceChange(id, JSON.parse(s), dragging);
        }
      }
    }

    return engine;
  };

  /**
   * Perte du contexte WebGL (pilote graphique réinitialisé, mise en veille…) :
   * p5 ne sait pas reprendre, on recharge la fenêtre — l'état et les médias sont
   * enregistrés. Au plus 3 rechargements par minute pour éviter une boucle.
   */
  function watchContextLoss(canvas) {
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("Contexte WebGL perdu : rechargement");
      let hist = [];
      try {
        hist = JSON.parse(sessionStorage.getItem("vm-gl-reloads") || "[]").filter((t) => Date.now() - t < 60000);
      } catch (err) {}
      if (hist.length >= 3) return;
      hist.push(Date.now());
      try {
        sessionStorage.setItem("vm-gl-reloads", JSON.stringify(hist));
      } catch (err) {}
      setTimeout(() => location.reload(), 800);
    });
  }

  /** Ajuste un canvas (taille fixe = résolution de projection) à son conteneur. */
  VM.fitCanvas = (canvas, box) => {
    if (!canvas) return;
    const r = box.getBoundingClientRect();
    const cw = canvas.width,
      ch = canvas.height;
    const k = Math.min(r.width / cw, r.height / ch);
    canvas.style.width = Math.floor(cw * k) + "px";
    canvas.style.height = Math.floor(ch * k) + "px";
  };
})();
