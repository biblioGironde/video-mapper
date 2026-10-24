/* =========================================================================
 * Video Mapper — « Depuis une photo »
 * Repère les surfaces d'un lieu sur une photo et en fait des calques.
 *
 *  1. photo du lieu (idéalement prise depuis le projecteur, mire blanche projetée)
 *  2. zone projetée : 4 coins de l'image du projecteur dans la photo
 *     → homographie photo → scène (coordonnées du projecteur)
 *  3. surfaces : détection automatique (OpenCV), baguette magique, polygone
 *  4. création des calques (quadrilatère = perspective, sinon polygone)
 * ========================================================================= */
(function () {
  const VM = (window.VM = window.VM || {});

  /* ------------------------------ OpenCV.js ------------------------------ */

  // NB : le module OpenCV.js 4.x possède une méthode then() qui se résout sur
  // lui-même : il ne faut jamais l'« await » ni le passer à resolve() directement
  // (boucle infinie). On l'enveloppe donc dans un objet.
  let cvPromise = null;
  VM.loadCV = () => {
    if (cvPromise) return cvPromise;
    cvPromise = new Promise((resolve0, reject) => {
      // une fois prêt, on retire then() pour pouvoir manipuler cv comme un objet normal
      const resolve = (w) => {
        try {
          w.cv.then = undefined;
        } catch (e) {}
        resolve0(w.cv);
      };
      const done = () => {
        const c = window.cv;
        if (!c) return reject(new Error("OpenCV introuvable"));
        if (c.Mat) return resolve({ cv: c });
        if (c instanceof Promise) return c.then((m) => resolve({ cv: (window.cv = m) }), reject);
        const prev = c.onRuntimeInitialized;
        c.onRuntimeInitialized = () => {
          prev && prev();
          resolve({ cv: c });
        };
        // au cas où l'initialisation serait déjà passée
        const iv = setInterval(() => c.Mat && (clearInterval(iv), resolve({ cv: c })), 100);
      };
      if (window.cv) return done();
      const s = document.createElement("script");
      s.src = "lib/opencv.js";
      s.async = true;
      s.onload = done;
      s.onerror = () => reject(new Error("Impossible de charger lib/opencv.js"));
      document.head.append(s);
    });
    return cvPromise;
  };

  /* ---------------------------- Géométrie pure --------------------------- */

  const G = (VM.geom = {});

  G.centroid = (pts) => {
    let x = 0,
      y = 0;
    pts.forEach((p) => ((x += p.x), (y += p.y)));
    return { x: x / pts.length, y: y / pts.length };
  };

  G.area = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i],
        q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };

  G.inside = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i],
        b = poly[j];
      if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };

  /** Ordonne 4 points : haut-gauche, haut-droit, bas-droit, bas-gauche. */
  G.orderQuad = (pts) => {
    const c = G.centroid(pts);
    const s = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
    // sens horaire à l'écran (y vers le bas) en partant du plus en haut à gauche
    let k = 0;
    s.forEach((p, i) => {
      if (p.x + p.y < s[k].x + s[k].y) k = i;
    });
    return [0, 1, 2, 3].map((i) => s[(k + i) % 4]);
  };

  /** Résout l'homographie qui envoie src[i] sur dst[i] (4 points). */
  G.homography = (src, dst) => {
    const A = [],
      b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i],
        { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    // élimination de Gauss
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [...h, 1];
  };

  G.apply = (H, p) => {
    const w = H[6] * p.x + H[7] * p.y + H[8];
    return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
  };

  /** Construit le JSON p5.mapper d'un QuadMap à partir de 4 coins (coordonnées WEBGL centrées). */
  G.quadJSON = (q) => {
    const [tl, tr, br, bl] = q;
    const n = VM.QUAD_RES;
    const minX = Math.min(...q.map((p) => p.x)),
      minY = Math.min(...q.map((p) => p.y));
    const w = Math.max(...q.map((p) => p.x)) - minX,
      h = Math.max(...q.map((p) => p.y)) - minY;
    const pt = (i, p, u, v) => ({ i, x: p.x - minX, y: p.y - minY, u, v });
    return {
      id: "0",
      type: "QUAD",
      res: n,
      resY: n,
      x: minX,
      y: minY,
      width: Math.round(w),
      height: Math.round(h),
      points: [pt(0, tl, 0, 0), pt(n - 1, tr, 1, 0), pt(n * (n - 1), bl, 0, 1), pt(n * n - 1, br, 1, 1)],
    };
  };

  G.polyJSON = (pts) => {
    const minX = Math.min(...pts.map((p) => p.x)),
      minY = Math.min(...pts.map((p) => p.y));
    return { id: "0", type: "POLY", x: minX, y: minY, points: pts.map((p, i) => ({ i, x: p.x - minX, y: p.y - minY })) };
  };

  /* ------------------------- Vision (OpenCV.js) -------------------------- */

  const matToPts = (m, k = 1) => {
    const out = [];
    for (let i = 0; i < m.rows; i++) out.push({ x: m.data32S[i * 2] / k, y: m.data32S[i * 2 + 1] / k });
    return out;
  };
  const ptsToMat = (cv, pts, k = 1) =>
    cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap((p) => [Math.round(p.x * k), Math.round(p.y * k)]));

  /** Réduit un contour à 4 sommets (enveloppe convexe puis approximation progressive). */
  function quadFromContour(cv, contour) {
    const hull = new cv.Mat();
    cv.convexHull(contour, hull, false, true);
    const peri = cv.arcLength(hull, true);
    let res = null;
    for (let e = 0.01; e <= 0.2 && !res; e += 0.01) {
      const ap = new cv.Mat();
      cv.approxPolyDP(hull, ap, e * peri, true);
      const n = ap.rows;
      if (n === 4) res = matToPts(ap);
      ap.delete();
      if (n < 4) break;
    }
    if (!res) {
      const r = cv.minAreaRect(hull);
      res = cv.RotatedRect.points(r).map((p) => ({ x: p.x, y: p.y }));
    }
    hull.delete();
    return G.orderQuad(res);
  }

  VM.vision = {
    /** Plus grande zone claire (image projetée en blanc) → 4 coins. */
    detectProjection(cv, canvas, k) {
      const src = cv.imread(canvas);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(7, 7), 0);
      const bin = new cv.Mat();
      cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const kernel = cv.Mat.ones(9, 9, cv.CV_8U);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
      const contours = new cv.MatVector(),
        hier = new cv.Mat();
      cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = -1,
        bestA = 0;
      for (let i = 0; i < contours.size(); i++) {
        const a = cv.contourArea(contours.get(i));
        if (a > bestA) {
          bestA = a;
          best = i;
        }
      }
      let quad = null;
      if (best >= 0 && bestA > canvas.width * canvas.height * 0.03) {
        quad = quadFromContour(cv, contours.get(best)).map((p) => ({ x: p.x / k, y: p.y / k }));
      }
      [src, gray, bin, kernel, contours, hier].forEach((m) => m.delete());
      return quad;
    },

    /** Régions fermées délimitées par des contours nets. */
    detectSurfaces(cv, canvas, k, frame, finesse = 5) {
      const src = cv.imread(canvas);
      // contours sur la luminance ET sur la couleur (espace Lab) : deux surfaces
      // de même clarté mais de teintes différentes restent séparées
      const rgb = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      const smooth = new cv.Mat();
      cv.bilateralFilter(rgb, smooth, 7, 40, 40);
      const lab = new cv.Mat();
      cv.cvtColor(smooth, lab, cv.COLOR_RGB2Lab);
      const ch = new cv.MatVector();
      cv.split(lab, ch);
      const lo = 8 + (10 - finesse) * 7; // finesse 5 → 43
      const edges = cv.Mat.zeros(src.rows, src.cols, cv.CV_8U);
      const e1 = new cv.Mat();
      for (let i = 0; i < 3; i++) {
        const c = ch.get(i);
        // les canaux a/b ont peu de dynamique : seuils réduits
        const l = i === 0 ? lo : lo * 0.45;
        cv.Canny(c, e1, l, l * 2.5, 3, true);
        cv.bitwise_or(edges, e1, edges);
      }
      [rgb, smooth, lab, ch, e1].forEach((m) => m.delete());
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      const contours = new cv.MatVector(),
        hier = new cv.Mat();
      cv.findContours(edges, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

      const frameS = frame.map((p) => ({ x: p.x * k, y: p.y * k }));
      const frameA = G.area(frameS);
      const found = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const a = cv.contourArea(c);
        if (a < frameA * 0.004 || a > frameA * 0.95) continue;
        const hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        const solidity = a / Math.max(1, cv.contourArea(hull));
        hull.delete();
        if (solidity < 0.75) continue;
        const ap = new cv.Mat();
        cv.approxPolyDP(c, ap, 0.012 * cv.arcLength(c, true), true);
        const pts = matToPts(ap);
        ap.delete();
        if (pts.length < 3) continue;
        if (pts.length > 14 && !VM.vision.circleQuad(cv, pts)) continue; // trop de sommets : seulement si c'est un disque
        if (!G.inside(G.centroid(pts), frameS)) continue;
        found.push({ pts: pts.map((p) => ({ x: p.x / k, y: p.y / k })), a });
      }
      [src, edges, kernel, contours, hier].forEach((m) => m.delete());

      // dédoublonnage (contours intérieur / extérieur d'une même forme)
      found.sort((x, y) => y.a - x.a);
      const diag = Math.hypot(canvas.width, canvas.height) / k;
      const kept = [];
      for (const f of found) {
        const c = G.centroid(f.pts);
        const dup = kept.some((g) => {
          const d = G.centroid(g.pts);
          const r = f.a / g.a;
          return Math.hypot(c.x - d.x, c.y - d.y) < diag * 0.03 && r > 0.7 && r < 1.43;
        });
        if (!dup) kept.push(f);
        if (kept.length >= 30) break;
      }
      return kept.map((f) => f.pts);
    },

    /** Baguette magique : remplissage par couleur voisine depuis un clic. */
    wand(cv, canvas, k, seed, tolerance = 25) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const W = canvas.width,
        H = canvas.height;
      const data = ctx.getImageData(0, 0, W, H).data;
      const sx = Math.round(seed.x * k),
        sy = Math.round(seed.y * k);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
      // couleur de référence = moyenne 5×5 autour du clic
      let r0 = 0,
        g0 = 0,
        b0 = 0,
        n0 = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.min(W - 1, Math.max(0, sx + dx)),
            y = Math.min(H - 1, Math.max(0, sy + dy));
          const o = (y * W + x) * 4;
          r0 += data[o];
          g0 += data[o + 1];
          b0 += data[o + 2];
          n0++;
        }
      r0 /= n0;
      g0 /= n0;
      b0 /= n0;
      const tol2 = (tolerance * 4.4) ** 2;
      const mask = new Uint8Array(W * H);
      const stack = [sy * W + sx];
      mask[sy * W + sx] = 255;
      let count = 0;
      while (stack.length) {
        const i = stack.pop();
        count++;
        const x = i % W,
          y = (i / W) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (const j of nb) {
          if (j < 0 || mask[j]) continue;
          const o = j * 4;
          const d = (data[o] - r0) ** 2 + (data[o + 1] - g0) ** 2 + (data[o + 2] - b0) ** 2;
          if (d <= tol2) {
            mask[j] = 255;
            stack.push(j);
          }
        }
      }
      if (count < 30) return null;
      const m = cv.matFromArray(H, W, cv.CV_8UC1, mask);
      const kernel = cv.Mat.ones(7, 7, cv.CV_8U);
      cv.morphologyEx(m, m, cv.MORPH_CLOSE, kernel);
      cv.morphologyEx(m, m, cv.MORPH_OPEN, cv.Mat.ones(3, 3, cv.CV_8U));
      const contours = new cv.MatVector(),
        hier = new cv.Mat();
      cv.findContours(m, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = -1,
        bestA = 0;
      for (let i = 0; i < contours.size(); i++) {
        const a = cv.contourArea(contours.get(i));
        if (a > bestA) {
          bestA = a;
          best = i;
        }
      }
      let pts = null;
      if (best >= 0) {
        const c = contours.get(best);
        const ap = new cv.Mat();
        cv.approxPolyDP(c, ap, 0.01 * cv.arcLength(c, true), true);
        pts = matToPts(ap).map((p) => ({ x: p.x / k, y: p.y / k }));
        ap.delete();
      }
      [m, kernel, contours, hier].forEach((x) => x.delete());
      return pts && pts.length >= 3 ? pts : null;
    },

    /**
     * Si le contour ressemble à un disque (vu de face ou en perspective : une
     * ellipse), renvoie les 4 coins du rectangle qui l'entoure, sinon null.
     */
    circleQuad(cv, pts) {
      if (!pts || pts.length < 8) return null;
      const m = ptsToMat(cv, pts, 4);
      let res = null;
      try {
        const r = cv.fitEllipse(m);
        const ea = (Math.PI * (r.size.width / 4) * (r.size.height / 4)) / 4; // aire de l'ellipse (échelle ×4 retirée)
        const ratio = G.area(pts) / Math.max(1, ea);
        if (ratio > 0.93 && ratio < 1.06) {
          res = G.orderQuad(cv.RotatedRect.points(r).map((q) => ({ x: q.x / 4, y: q.y / 4 })));
        }
      } catch (e) {}
      m.delete();
      return res;
    },

    toQuad(cv, pts) {
      const m = ptsToMat(cv, pts, 1);
      const q = quadFromContour(cv, m);
      m.delete();
      return q;
    },

    /** Simplifie un polygone à au plus `max` sommets. */
    simplify(cv, pts, max = 16) {
      if (pts.length <= max) return pts;
      const m = ptsToMat(cv, pts, 4);
      const peri = cv.arcLength(m, true);
      let out = pts;
      for (let e = 0.005; e < 0.1; e += 0.005) {
        const ap = new cv.Mat();
        cv.approxPolyDP(m, ap, e * peri, true);
        const r = matToPts(ap, 4);
        ap.delete();
        if (r.length <= max) {
          out = r;
          break;
        }
      }
      m.delete();
      return out;
    },

    /** Redresse la photo dans le repère du projecteur (fond de l'éditeur). */
    warpToStage(cv, canvas, k, frame, W, H) {
      const src = cv.imread(canvas);
      const s = frame.map((p) => [p.x * k, p.y * k]).flat();
      const srcM = cv.matFromArray(4, 1, cv.CV_32FC2, s);
      const dstM = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
      const M = cv.getPerspectiveTransform(srcM, dstM);
      const out = new cv.Mat();
      cv.warpPerspective(src, out, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
      const c = document.createElement("canvas");
      cv.imshow(c, out);
      [src, srcM, dstM, M, out].forEach((m) => m.delete());
      return c;
    },
  };

  /* --------------------------------- UI ---------------------------------- */

  const COLORS = ["#ff5d73", "#4cc9f0", "#ffd166", "#06d6a0", "#b388ff", "#ff9f1c", "#90be6d", "#f72585"];

  VM.openPhotoTool = (api) => {
    // api: { getState(), addLayers(layers), setBackdrop(b), setTestPattern(kind), toast(msg) }
    const $ = (s, r = root) => r.querySelector(s);
    let cv = null;
    let img = null; // HTMLImageElement (taille réelle)
    let work = null; // canvas de travail réduit
    let k = 1; // facteur photo → travail
    let frame = null; // 4 coins de la zone projetée (coordonnées photo)
    let cands = []; // {id, pts, selected, src}
    let tool = "select";
    let drawing = null; // points du polygone en cours
    let drag = null;
    let view = { s: 1, ox: 0, oy: 0 };
    let hover = null;

    const root = document.createElement("div");
    root.className = "phototool";
    root.innerHTML = `
      <div class="pt-view" id="ptView">
        <canvas id="ptCanvas"></canvas>
        <div class="pt-empty" id="ptEmpty">
          <p><b>Choisissez une photo du lieu</b></p>
          <p>Pour un résultat juste, prenez-la <b>depuis l'emplacement du projecteur</b>
          (appareil collé à l'objectif), si possible avec la <b>mire blanche</b> projetée :
          l'app retrouvera seule la zone couverte par le projecteur.</p>
          <label class="btn primary">Choisir une photo<input type="file" id="ptFile" accept="image/*" hidden></label>
        </div>
        <div class="pt-busy" id="ptBusy" hidden>Analyse…</div>
      </div>
      <aside class="pt-side">
        <div class="pt-head"><h2>Calques depuis une photo</h2><button class="icon" id="ptClose" title="Fermer">✕</button></div>

        <section class="panel">
          <h3><span class="num">1</span> Photo</h3>
          <div class="row">
            <label class="btn small">Changer de photo<input type="file" id="ptFile2" accept="image/*" hidden></label>
          </div>
          <p class="hint">Projetez une mire pendant la prise de vue :</p>
          <div class="seg" id="ptPattern">
            <button data-v="">Aucune</button><button data-v="white">Blanche</button><button data-v="grid">Grille</button>
          </div>
        </section>

        <section class="panel">
          <h3><span class="num">2</span> Zone du projecteur</h3>
          <p class="hint">Placez les 4 poignées <b style="color:var(--accent)">vertes</b> sur les coins de l'image projetée. Si la photo est prise du projecteur sans mire, gardez « toute la photo ».</p>
          <div class="row">
            <button class="small" id="ptDetectFrame" title="Nécessite la mire blanche sur la photo">Détecter la mire</button>
            <button class="small" id="ptFullFrame">Toute la photo</button>
          </div>
        </section>

        <section class="panel">
          <h3><span class="num">3</span> Surfaces</h3>
          <div class="seg full" id="ptTool">
            <button data-v="select" title="Cliquer une forme pour la cocher, glisser ses sommets pour l'ajuster">Sélection</button>
            <button data-v="wand" title="Cliquer dans une surface unie">Baguette</button>
            <button data-v="poly" title="Cliquer les sommets, re-cliquer le premier (ou Entrée) pour fermer">Polygone</button>
          </div>
          <div class="row" id="ptWandOpts"><label class="hint" style="margin:0">Tolérance</label><input type="range" id="ptTol" min="4" max="60" value="22"><span class="val" id="ptTolV">22</span></div>
          <div class="row">
            <button class="small" id="ptAuto">Détection automatique</button>
            <label class="hint" style="margin:0" title="Plus fin = plus de formes détectées">Finesse</label>
            <input type="range" id="ptFin" min="1" max="10" value="5" style="width:80px">
          </div>
          <ul class="pt-list" id="ptList"></ul>
          <div class="row">
            <button class="small" id="ptAll">Tout cocher</button>
            <button class="small" id="ptNone">Tout décocher</button>
            <button class="small" id="ptClear">Effacer</button>
          </div>
        </section>

        <section class="panel">
          <h3><span class="num">4</span> Créer</h3>
          <label class="check"><input type="checkbox" id="ptCircles" checked> reconnaître les cercles</label>
          <label class="check"><input type="checkbox" id="ptForceQuad" checked> tout en quadrilatères (perspective)</label>
          <p class="hint">Décoché : les formes à plus de 4 côtés deviennent des polygones (texture non déformée en perspective).</p>
          <label class="check"><input type="checkbox" id="ptBackdrop" checked> photo redressée en fond de l'éditeur</label>
          <button class="primary" id="ptCreate" disabled>Créer les calques</button>
        </section>
      </aside>`;
    document.body.append(root);

    const canvas = $("#ptCanvas");
    const ctx = canvas.getContext("2d");
    const viewBox = $("#ptView");

    const busy = (on, msg) => {
      $("#ptBusy").hidden = !on;
      if (msg) $("#ptBusy").textContent = msg;
    };

    const ensureCV = async () => {
      if (cv) return cv;
      busy(true, "Chargement d'OpenCV…");
      try {
        cv = await VM.loadCV();
      } finally {
        busy(false);
      }
      return cv;
    };

    /* ----------------------------- chargement ---------------------------- */

    async function loadPhoto(file) {
      if (!file) return;
      const url = URL.createObjectURL(file);
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res;
        im.onerror = rej;
        im.src = url;
      });
      img = im;
      const max = 1400;
      k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      work = document.createElement("canvas");
      work.width = Math.round(im.naturalWidth * k);
      work.height = Math.round(im.naturalHeight * k);
      work.getContext("2d", { willReadFrequently: true }).drawImage(im, 0, 0, work.width, work.height);
      frame = fullFrame();
      cands = [];
      $("#ptEmpty").hidden = true;
      layout();
      renderList();
      // tentative silencieuse de repérage de la mire
      try {
        await ensureCV();
        const q = VM.vision.detectProjection(cv, work, k);
        if (q && G.area(q) < G.area(fullFrame()) * 0.97) {
          frame = q;
          api.toast("Zone projetée repérée — vérifiez les 4 coins verts");
        }
      } catch (e) {
        console.warn(e);
      }
      draw();
    }

    const fullFrame = () => {
      const w = img.naturalWidth,
        h = img.naturalHeight;
      return [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
    };

    $("#ptFile").onchange = (e) => loadPhoto(e.target.files[0]);
    $("#ptFile2").onchange = (e) => loadPhoto(e.target.files[0]);

    /* ------------------------------- vue --------------------------------- */

    function layout() {
      const r = viewBox.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (img) {
        const pad = 24;
        const s = Math.min((r.width - pad * 2) / img.naturalWidth, (r.height - pad * 2) / img.naturalHeight);
        view = { s, ox: (r.width - img.naturalWidth * s) / 2, oy: (r.height - img.naturalHeight * s) / 2 };
      }
      draw();
    }
    const onResize = () => layout();
    window.addEventListener("resize", onResize);

    const toView = (p) => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });
    const toPhoto = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left - view.ox) / view.s, y: (e.clientY - r.top - view.oy) / view.s };
    };

    function pathOf(pts) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const v = toView(p);
        i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y);
      });
      ctx.closePath();
    }

    function draw() {
      const r = viewBox.getBoundingClientRect();
      ctx.clearRect(0, 0, r.width, r.height);
      if (!img) return;
      ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.s, img.naturalHeight * view.s);

      // assombrit l'extérieur de la zone projetée
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, r.width, r.height);
      frame.forEach((p, i) => {
        const v = toView(p);
        i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fill("evenodd");
      ctx.restore();

      // surfaces
      cands.forEach((c, idx) => {
        const col = COLORS[idx % COLORS.length];
        pathOf(c.pts);
        ctx.fillStyle = c.selected ? col + "55" : "rgba(255,255,255,.06)";
        ctx.fill();
        ctx.lineWidth = c === hover ? 3 : 2;
        ctx.setLineDash(c.selected ? [] : [5, 4]);
        ctx.strokeStyle = c.selected ? col : "rgba(255,255,255,.5)";
        ctx.stroke();
        ctx.setLineDash([]);
        const m = toView(G.centroid(c.pts));
        ctx.fillStyle = "#000c";
        ctx.beginPath();
        ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = c.selected ? col : "#aaa";
        ctx.font = "bold 12px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(idx + 1), m.x, m.y);
        if (c.selected && tool === "select") {
          c.pts.forEach((p) => {
            const v = toView(p);
            ctx.fillStyle = "#fff";
            ctx.fillRect(v.x - 3.5, v.y - 3.5, 7, 7);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(v.x - 3.5, v.y - 3.5, 7, 7);
          });
        }
      });

      // cadre projecteur
      pathOf(frame);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#5ee6c4";
      ctx.stroke();
      ["HG", "HD", "BD", "BG"].forEach((lab, i) => {
        const v = toView(frame[i]);
        ctx.fillStyle = "#5ee6c4";
        ctx.beginPath();
        ctx.arc(v.x, v.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#062b22";
        ctx.font = "bold 9px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lab, v.x, v.y);
      });

      // polygone en cours
      if (drawing && drawing.length) {
        ctx.beginPath();
        drawing.forEach((p, i) => {
          const v = toView(p);
          i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y);
        });
        if (drawing.mouse) {
          const v = toView(drawing.mouse);
          ctx.lineTo(v.x, v.y);
        }
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 2;
        ctx.stroke();
        drawing.forEach((p, i) => {
          const v = toView(p);
          ctx.fillStyle = i === 0 ? "#ffd166" : "#fff";
          ctx.beginPath();
          ctx.arc(v.x, v.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    /* ---------------------------- interaction ---------------------------- */

    const near = (a, b, px = 10) => Math.hypot((a.x - b.x) * view.s, (a.y - b.y) * view.s) < px;

    function hitCand(p) {
      for (let i = cands.length - 1; i >= 0; i--) if (G.inside(p, cands[i].pts)) return cands[i];
      return null;
    }

    canvas.addEventListener("pointerdown", async (e) => {
      if (!img) return;
      const p = toPhoto(e);
      // poignées du cadre (prioritaires)
      const fi = frame.findIndex((f) => near(f, p, 12));
      if (fi >= 0) {
        drag = { kind: "frame", i: fi };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === "select") {
        for (const c of cands) {
          if (!c.selected) continue;
          const vi = c.pts.findIndex((q) => near(q, p, 8));
          if (vi >= 0) {
            drag = { kind: "vertex", c, i: vi };
            canvas.setPointerCapture(e.pointerId);
            return;
          }
        }
        const c = hitCand(p);
        if (c) {
          c.selected = !c.selected;
          renderList();
          draw();
        }
      } else if (tool === "wand") {
        await ensureCV();
        busy(true, "Analyse…");
        await new Promise((r) => setTimeout(r, 10));
        const pts = VM.vision.wand(cv, work, k, p, +$("#ptTol").value);
        busy(false);
        if (pts) addCand(VM.vision.simplify(cv, pts, 16), "baguette");
        else api.toast("Rien trouvé ici — augmentez la tolérance");
      } else if (tool === "poly") {
        if (!drawing) drawing = [];
        if (drawing.length >= 3 && near(drawing[0], p, 10)) return closePoly();
        drawing.push(p);
        draw();
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!img) return;
      const p = toPhoto(e);
      if (drag) {
        const W = img.naturalWidth,
          H = img.naturalHeight;
        const q = { x: Math.max(-W, Math.min(2 * W, p.x)), y: Math.max(-H, Math.min(2 * H, p.y)) };
        if (drag.kind === "frame") frame[drag.i] = q;
        else drag.c.pts[drag.i] = q;
        draw();
        return;
      }
      if (drawing) {
        drawing.mouse = p;
        draw();
        return;
      }
      const h = tool === "select" ? hitCand(p) : null;
      const onHandle = frame.some((f) => near(f, p, 12));
      canvas.style.cursor = onHandle ? "move" : tool === "wand" ? "crosshair" : tool === "poly" ? "copy" : h ? "pointer" : "default";
      if (h !== hover) {
        hover = h;
        draw();
      }
    });

    canvas.addEventListener("pointerup", () => {
      if (drag && drag.kind === "frame") frame = G.orderQuad(frame);
      drag = null;
      draw();
    });

    canvas.addEventListener("dblclick", () => drawing && drawing.length >= 3 && closePoly());

    function closePoly() {
      const pts = drawing.slice();
      drawing = null;
      addCand(pts, "manuel");
    }

    const onKey = (e) => {
      if (e.key === "Escape") {
        if (drawing) {
          drawing = null;
          draw();
        } else close();
        e.stopPropagation();
        e.preventDefault();
      } else if (e.key === "Enter" && drawing && drawing.length >= 3) {
        closePoly();
        e.preventDefault();
      } else if ((e.key === "Delete" || e.key === "Backspace") && hover && !VM.isTypingTarget(e.target)) {
        cands = cands.filter((c) => c !== hover);
        hover = null;
        renderList();
        draw();
        e.preventDefault();
      }
      e.stopPropagation(); // les raccourcis de spectacle sont inactifs dans l'outil
    };
    window.addEventListener("keydown", onKey, true);

    function addCand(pts, src) {
      cands.push({ id: VM.uid("c"), pts, selected: true, src });
      renderList();
      draw();
    }

    function setTool(t) {
      tool = t;
      drawing = null;
      root.querySelectorAll("#ptTool button").forEach((b) => b.classList.toggle("on", b.dataset.v === t));
      $("#ptWandOpts").style.display = t === "wand" ? "flex" : "none";
      draw();
    }
    $("#ptTool").onclick = (e) => {
      const b = e.target.closest("button");
      if (b) setTool(b.dataset.v);
    };
    $("#ptTol").oninput = (e) => ($("#ptTolV").textContent = e.target.value);

    function renderPattern() {
      const cur = api.getState().testPattern || "";
      root.querySelectorAll("#ptPattern button").forEach((b) => b.classList.toggle("on", b.dataset.v === cur));
    }
    $("#ptPattern").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      api.setTestPattern(b.dataset.v || null);
      renderPattern();
    };

    $("#ptDetectFrame").onclick = async () => {
      if (!img) return;
      await ensureCV();
      const q = VM.vision.detectProjection(cv, work, k);
      if (q) {
        frame = q;
        draw();
      } else api.toast("Aucune zone claire trouvée : placez les coins à la main");
    };
    $("#ptFullFrame").onclick = () => {
      if (!img) return;
      frame = fullFrame();
      draw();
    };

    $("#ptAuto").onclick = async () => {
      if (!img) return;
      await ensureCV();
      busy(true, "Détection des surfaces…");
      await new Promise((r) => setTimeout(r, 20));
      try {
        const found = VM.vision.detectSurfaces(cv, work, k, frame, +$("#ptFin").value);
        cands = cands.filter((c) => c.src !== "auto");
        // peu de formes : on les coche d'office ; sinon l'utilisateur choisit
        const pre = found.length <= 10;
        found.forEach((pts) => cands.push({ id: VM.uid("c"), pts, selected: pre, src: "auto" }));
        api.toast(found.length ? found.length + " formes trouvées — cliquez une forme pour la cocher / décocher" : "Aucune forme nette — essayez la baguette");
      } catch (e) {
        console.error(e);
        api.toast("Erreur de détection");
      }
      busy(false);
      renderList();
      draw();
    };

    $("#ptAll").onclick = () => (cands.forEach((c) => (c.selected = true)), renderList(), draw());
    $("#ptNone").onclick = () => (cands.forEach((c) => (c.selected = false)), renderList(), draw());
    $("#ptClear").onclick = () => ((cands = []), renderList(), draw());

    function renderList() {
      const ul = $("#ptList");
      ul.innerHTML = "";
      if (!cands.length) {
        ul.innerHTML = '<li class="empty">Aucune surface. Lancez la détection ou utilisez la baguette.</li>';
      }
      cands.forEach((c, i) => {
        const li = document.createElement("li");
        const col = COLORS[i % COLORS.length];
        li.innerHTML = `<label class="check"><input type="checkbox" ${c.selected ? "checked" : ""}>
          <span class="dot" style="background:${col}"></span> Surface ${i + 1}</label>
          <small>${cv && VM.vision.circleQuad(cv, c.pts) ? "cercle" : c.pts.length === 4 ? "quadrilatère" : c.pts.length + " côtés"} · ${c.src}</small>
          <button class="icon" title="Supprimer">✕</button>`;
        li.querySelector("input").onchange = (e) => {
          c.selected = e.target.checked;
          draw();
          updateCreate();
        };
        li.querySelector("button").onclick = () => {
          cands = cands.filter((x) => x !== c);
          renderList();
          draw();
        };
        li.onmouseenter = () => ((hover = c), draw());
        li.onmouseleave = () => ((hover = null), draw());
        ul.append(li);
      });
      updateCreate();
    }

    function updateCreate() {
      const n = cands.filter((c) => c.selected).length;
      const b = $("#ptCreate");
      b.disabled = !n;
      b.textContent = n ? `Créer ${n} calque${n > 1 ? "s" : ""}` : "Créer les calques";
    }

    /* ------------------------------ création ----------------------------- */

    $("#ptCreate").onclick = async () => {
      await ensureCV();
      const st = api.getState().stage;
      const H = G.homography(frame, [
        { x: 0, y: 0 },
        { x: st.w, y: 0 },
        { x: st.w, y: st.h },
        { x: 0, y: st.h },
      ]);
      const toStage = (p) => {
        const q = G.apply(H, p);
        return { x: q.x - st.w / 2, y: q.y - st.h / 2 }; // repère WEBGL centré
      };
      const forceQuad = $("#ptForceQuad").checked;
      const sel = cands.filter((c) => c.selected);
      const out = [];
      sel.forEach((c, i) => {
        const n = cands.indexOf(c) + 1;
        let shape, surface, polyCount = 0, aspect;
        const cq = $("#ptCircles").checked ? VM.vision.circleQuad(cv, c.pts) : null;
        if (cq) {
          // disque : quadrilatère qui l'entoure + découpe en ellipse
          const q = cq.map(toStage);
          shape = "circle";
          surface = G.quadJSON(q);
          aspect = 1;
        // triangles : toujours en polygone (un quadrilatère dégénéré ne se déforme pas)
        } else if (c.pts.length === 4 || (forceQuad && c.pts.length > 4)) {
          const q = (c.pts.length === 4 ? G.orderQuad(c.pts) : VM.vision.toQuad(cv, c.pts)).map(toStage);
          shape = "quad";
          surface = G.quadJSON(q);
          const wTop = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y),
            hLeft = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
          aspect = wTop / Math.max(1, hLeft);
        } else {
          const pts = VM.vision.simplify(cv, c.pts, 16).map(toStage);
          shape = "poly";
          polyCount = pts.length;
          surface = G.polyJSON(pts);
          const xs = pts.map((p) => p.x),
            ys = pts.map((p) => p.y);
          aspect = (Math.max(...xs) - Math.min(...xs)) / Math.max(1, Math.max(...ys) - Math.min(...ys));
        }
        out.push({ name: "Surface " + n, shape, polyCount, surface, aspect, fit: shape === "circle" ? "cover" : "stretch", color: COLORS[(n - 1) % COLORS.length] });
      });

      let backdrop = null;
      if ($("#ptBackdrop").checked) {
        busy(true, "Redressement de la photo…");
        await new Promise((r) => setTimeout(r, 20));
        // redressement depuis une copie haute définition (2400 px max)
        const kk = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        const hi = document.createElement("canvas");
        hi.width = Math.round(img.naturalWidth * kk);
        hi.height = Math.round(img.naturalHeight * kk);
        hi.getContext("2d").drawImage(img, 0, 0, hi.width, hi.height);
        const bw = Math.min(st.w, 1920),
          bh = Math.round((st.h * bw) / st.w);
        const warped = VM.vision.warpToStage(cv, hi, kk, frame, bw, bh);
        const blob = await new Promise((r) => warped.toBlob(r, "image/jpeg", 0.88));
        const rec = await VM.putMedia(new File([blob], "photo-reperage.jpg", { type: "image/jpeg" }), { hidden: true });
        backdrop = { mediaId: rec.id, opacity: 0.5, show: true };
        busy(false);
      }
      api.addLayers(out, backdrop);
      close();
    };

    /* ------------------------------ fermeture ---------------------------- */

    function close() {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, true);
      root.remove();
      api.onClose && api.onClose();
    }
    $("#ptClose").onclick = close;

    setTool("select");
    renderPattern();
    renderList();
    requestAnimationFrame(layout);

    return (window.__pt = { loadPhoto, close, get cands() { return cands; }, get frame() { return frame; }, set frame(f) { frame = f; draw(); } });
  };
})();
