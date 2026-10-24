/* =========================================================================
 * Video Mapper — processus principal Electron
 *  - sert l'interface via le protocole app:// (origine stable : IndexedDB,
 *    localStorage et BroadcastChannel partagés entre les deux fenêtres)
 *  - fenêtre d'édition + fenêtre de sortie plein écran sur l'écran choisi
 *  - son autorisé sans clic, mise en veille de l'écran bloquée pendant la sortie
 * ========================================================================= */
const { app, BrowserWindow, Menu, ipcMain, protocol, net, screen, powerSaveBlocker, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const APP_DIR = path.join(__dirname, "app");
const isMac = process.platform === "darwin";

// lecture vidéo avec son sans geste utilisateur
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------- Réglages ------------------------------- */

const settingsFile = () => path.join(app.getPath("userData"), "reglages.json");
let settings = { outputDisplayId: null, outputDisplayLabel: null, autoOpenOutput: false, outputFullscreen: true };
function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), "utf8")));
  } catch (e) {}
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.warn("Réglages non enregistrés", e);
  }
}

/* -------------------------------- Écrans -------------------------------- */

function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || (d.id === primary.id ? "Écran principal" : "Écran " + (i + 1)),
    primary: d.id === primary.id,
    internal: !!d.internal,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    bounds: d.bounds,
  }));
}

/** Écran de sortie : celui mémorisé s'il est branché, sinon le premier écran secondaire. */
function pickDisplay(id) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return (
    all.find((d) => d.id === id) ||
    all.find((d) => d.id === settings.outputDisplayId) ||
    all.find((d) => d.label && d.label === settings.outputDisplayLabel) ||
    all.find((d) => d.id !== primary.id) ||
    primary
  );
}

/* ------------------------------- Fenêtres ------------------------------- */

let editorWin = null;
let outputWin = null;
let blockerId = null;

const webPrefs = () => ({
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false, // la sortie continue à tourner même masquée
});

function createEditor() {
  editorWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Video Mapper",
    backgroundColor: "#0e0f12",
    show: false,
    webPreferences: webPrefs(),
  });
  editorWin.loadURL("app://local/index.html");
  editorWin.once("ready-to-show", () => editorWin.show());
  editorWin.on("closed", () => {
    editorWin = null;
    if (outputWin) outputWin.close();
    app.quit();
  });
  guardNavigation(editorWin);
  editorWin.webContents.setWindowOpenHandler(({ url }) => {
    // window.open("sortie.html") depuis l'interface web → fenêtre de sortie native
    if (/sortie\.html/.test(url)) {
      openOutput();
      return { action: "deny" };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function openOutput(displayId, fullscreen) {
  const d = pickDisplay(displayId);
  const fs_ = fullscreen ?? settings.outputFullscreen;
  settings.outputDisplayId = d.id;
  settings.outputDisplayLabel = d.label || null;
  settings.outputFullscreen = fs_;
  saveSettings();

  const onPrimary = d.id === screen.getPrimaryDisplay().id;
  const b = d.bounds;

  if (!outputWin) {
    outputWin = new BrowserWindow({
      x: b.x + (onPrimary ? 80 : 0),
      y: b.y + (onPrimary ? 80 : 0),
      width: onPrimary ? Math.round(b.width * 0.6) : b.width,
      height: onPrimary ? Math.round(b.height * 0.6) : b.height,
      title: "Video Mapper — Sortie",
      backgroundColor: "#000000",
      frame: !fs_,
      autoHideMenuBar: true,
      show: false,
      webPreferences: webPrefs(),
    });
    outputWin.loadURL("app://local/sortie.html");
    guardNavigation(outputWin);
    outputWin.once("ready-to-show", () => {
      outputWin.show();
      if (fs_) outputWin.setFullScreen(true);
      if (editorWin) editorWin.focus(); // le clavier reste sur l'éditeur
    });
    outputWin.on("closed", () => {
      outputWin = null;
      stopBlocker();
      notifyEditor();
      buildMenu();
    });
    outputWin.on("enter-full-screen", notifyEditor);
    outputWin.on("leave-full-screen", notifyEditor);
    startBlocker();
  } else {
    // déplacement vers un autre écran
    const wasFs = outputWin.isFullScreen();
    const move = () => {
      outputWin.setBounds(onPrimary ? { x: b.x + 80, y: b.y + 80, width: Math.round(b.width * 0.6), height: Math.round(b.height * 0.6) } : b);
      if (fs_) outputWin.setFullScreen(true);
      notifyEditor();
    };
    if (wasFs) {
      outputWin.once("leave-full-screen", () => setTimeout(move, 300));
      outputWin.setFullScreen(false);
    } else move();
  }
  notifyEditor();
  buildMenu();
}

function toggleOutputFullscreen() {
  if (!outputWin) return openOutput(undefined, true);
  const on = !outputWin.isFullScreen();
  outputWin.setFullScreen(on);
  settings.outputFullscreen = on;
  saveSettings();
}

function closeOutput() {
  if (outputWin) outputWin.close();
}

function startBlocker() {
  if (blockerId === null) blockerId = powerSaveBlocker.start("prevent-display-sleep");
}
function stopBlocker() {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  blockerId = null;
}

function outputState() {
  let displayId = null;
  if (outputWin) displayId = screen.getDisplayMatching(outputWin.getBounds()).id;
  return {
    open: !!outputWin,
    fullscreen: !!(outputWin && outputWin.isFullScreen()),
    displayId: displayId ?? settings.outputDisplayId,
    autoOpen: settings.autoOpenOutput,
    displays: displayList(),
  };
}

function notifyEditor() {
  if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send("output-state", outputState());
}

/** Pas de navigation hors de l'app (un lien ou un fichier déposé ne remplace pas l'interface). */
function guardNavigation(win) {
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://local/")) e.preventDefault();
  });
}

/* --------------------------------- Menus -------------------------------- */

const toEditor = (action) => () => editorWin && editorWin.webContents.send("menu", action);

function buildMenu() {
  const displays = displayList();
  const st = outputState();
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Fichier",
      submenu: [
        { label: "Importer des médias…", accelerator: "CmdOrCtrl+I", click: toEditor("import-media") },
        { label: "Calques depuis une photo…", click: toEditor("photo") },
        { type: "separator" },
        { label: "Ouvrir un projet…", accelerator: "CmdOrCtrl+O", click: toEditor("import-project") },
        { label: "Exporter le projet…", accelerator: "CmdOrCtrl+S", click: toEditor("export-project") },
        { type: "separator" },
        isMac ? { role: "close", label: "Fermer la fenêtre" } : { role: "quit", label: "Quitter" },
      ],
    },
    { label: "Édition", submenu: [{ role: "undo", label: "Annuler" }, { role: "redo", label: "Rétablir" }, { type: "separator" }, { role: "cut", label: "Couper" }, { role: "copy", label: "Copier" }, { role: "paste", label: "Coller" }, { role: "selectAll", label: "Tout sélectionner" }] },
    {
      label: "Sortie",
      submenu: [
        ...displays.map((d) => ({
          label: `Ouvrir sur ${d.label} (${d.width}×${d.height})${d.primary ? " — principal" : ""}`,
          type: "radio",
          checked: st.open && st.displayId === d.id,
          click: () => openOutput(d.id),
        })),
        { type: "separator" },
        { label: "Plein écran on / off", accelerator: "CmdOrCtrl+Shift+F", click: toggleOutputFullscreen },
        { label: "Fermer la sortie", accelerator: "CmdOrCtrl+Shift+W", enabled: st.open, click: closeOutput },
        { type: "separator" },
        {
          label: "Ouvrir la sortie au démarrage",
          type: "checkbox",
          checked: settings.autoOpenOutput,
          click: (it) => {
            settings.autoOpenOutput = it.checked;
            saveSettings();
            notifyEditor();
          },
        },
      ],
    },
    {
      label: "Présentation",
      submenu: [
        { label: "Noir général", accelerator: "CmdOrCtrl+B", click: toEditor("blackout") },
        { label: "Tout lire / pause", accelerator: "CmdOrCtrl+P", click: toEditor("allplay") },
        { label: "Tout au début", accelerator: "CmdOrCtrl+R", click: toEditor("allrestart") },
        { type: "separator" },
        { label: "Mode calibration on / off", accelerator: "CmdOrCtrl+K", click: toEditor("calibrate") },
        { label: "Repères sur la sortie on / off", accelerator: "CmdOrCtrl+G", click: toEditor("guides") },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger l'éditeur", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools", label: "Outils de développement" },
        { type: "separator" },
        { role: "resetZoom", label: "Taille réelle" },
        { role: "zoomIn", label: "Agrandir" },
        { role: "zoomOut", label: "Réduire" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Éditeur en plein écran" },
      ],
    },
    { role: "windowMenu", label: "Fenêtre" },
    {
      role: "help",
      label: "Aide",
      submenu: [
        { label: "Dossier des données de l'app", click: () => shell.openPath(app.getPath("userData")) },
        { label: "p5.mapper sur GitHub", click: () => shell.openExternal("https://github.com/jdeboi/p5.mapper") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------- IPC --------------------------------- */

ipcMain.handle("vm:state", () => outputState());
ipcMain.handle("vm:open-output", (_e, displayId, fullscreen) => openOutput(displayId ?? undefined, fullscreen ?? undefined));
ipcMain.handle("vm:close-output", () => closeOutput());
ipcMain.handle("vm:toggle-fullscreen", () => toggleOutputFullscreen());
ipcMain.handle("vm:set-auto-open", (_e, on) => {
  settings.autoOpenOutput = !!on;
  saveSettings();
  buildMenu();
  notifyEditor();
});
ipcMain.handle("vm:focus-editor", () => editorWin && editorWin.focus());

/* -------------------------------- Démarrage ----------------------------- */

app.whenReady().then(() => {
  loadSettings();

  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR)) return new Response("Interdit", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createEditor();
  buildMenu();

  const onDisplays = () => {
    buildMenu();
    notifyEditor();
  };
  screen.on("display-added", (_e, d) => {
    // le vidéoprojecteur mémorisé revient : on y renvoie la sortie
    if (outputWin && (d.id === settings.outputDisplayId || (d.label && d.label === settings.outputDisplayLabel))) {
      setTimeout(() => openOutput(d.id), 800);
    }
    onDisplays();
  });
  screen.on("display-removed", onDisplays);
  screen.on("display-metrics-changed", onDisplays);

  if (settings.autoOpenOutput) {
    editorWin.webContents.once("did-finish-load", () => setTimeout(() => openOutput(), 500));
  }
});

app.on("second-instance", () => {
  if (editorWin) {
    if (editorWin.isMinimized()) editorWin.restore();
    editorWin.focus();
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", stopBlocker);

process.on("uncaughtException", (e) => {
  console.error(e);
  dialog.showErrorBox("Video Mapper", String(e && e.stack ? e.stack : e));
});
