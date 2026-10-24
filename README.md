# Video Mapper

Application de **vidéo-mapping** libre : calques vidéo ou image avec transparence, calage en perspective sur les surfaces réelles, écran d'édition séparé de l'écran de projection, déclenchement au clavier.

Elle repose sur [p5.js](https://p5js.org) et [p5.mapper](https://github.com/jdeboi/p5.mapper) (Jenna deBoisblanc), et fonctionne de deux façons :
- dans un **navigateur** ;
- comme **application de bureau** (Electron) pour macOS, Windows et Linux.

- **Version web** : https://bibliogironde.github.io/video-mapper/
- **Applications à télécharger** : onglet [Releases](https://github.com/biblioGironde/video-mapper/releases)

## Fonctions

- **Calques** illimités. Chaque calque associe **une forme** et **un média** (vidéo ou image). On peut régler la visibilité, l'opacité, les fondus, le mode solo et l'ordre, et dupliquer un calque.
- **Formes** :
  - *Rectangle déformable* : le média suit les 4 coins en perspective.
  - *Cercle / ellipse en perspective*, avec un réglage de bord doux.
  - *Triangle*, *polygones*, *4 points libres* : la forme découpe le média comme un masque.
  - *Reprendre la forme* d'un autre calque.
- **Cadrage du média dans sa forme** :
  - trois ajustements : étirer, remplir (en rognant) ou ajuster (avec bandes transparentes) ;
  - déplacement, zoom et rotation, à la souris ou avec des curseurs.
- **Transparence** : vidéos WebM VP9 avec canal alpha, HEVC avec alpha (Safari / macOS), PNG, WebP et GIF transparents.
- **Lecture** : boucle, pause, retour au début, vitesse, son coupé et volume par calque.
- **Deux écrans** : l'éditeur, toujours muet, et la sortie plein écran pour le vidéoprojecteur, qui joue le son. Ils sont synchronisés en direct.
- **Clavier** : on associe une touche à une action, par exemple afficher ou masquer, fondu entrant ou sortant, solo, lecture/pause, retour au début, son, boucle ou noir général. Plusieurs actions sur la même touche forment une *cue*.
- **Calques depuis une photo du lieu** : à partir d'une photo, l'outil repère la zone éclairée par le projecteur (avec une mire projetée), puis les surfaces. La détection peut être automatique (OpenCV.js) ou se faire à la baguette magique ou au polygone. Les disques sont reconnus.
- **Projet** exportable et importable en `.json` : calques, calibration et raccourcis. Les médias restent stockés dans le navigateur ou l'application ; ils sont reliés de nouveau par leur nom de fichier.

### Modes d'édition de la scène

| Mode | Ce que fait la souris |
|---|---|
| Lecture | Rien : aucune poignée |
| Coins + déplacer | Un coin déforme la forme ; l'intérieur la déplace |
| Coins seuls | Ne bouge que les coins et sommets, pour le calage fin |
| Déplacer seul | Déplace les formes en bloc ; les coins sont verrouillés |
| Cadrer le média | Glisser déplace le média ; la molette zoome ; Maj + molette le fait tourner ; un double-clic le recentre |

## Installer l'application de bureau

Téléchargez le fichier de votre système dans [Releases](https://github.com/biblioGironde/video-mapper/releases).

- **Mac** (fichier `.dmg` : `arm64` pour les puces M1 à M4, `x64` pour les Mac Intel).
  1. Glissez l'app dans Applications.
  2. Au premier lancement seulement, l'app n'étant pas signée par un développeur Apple, exécutez dans le Terminal :
     ```sh
     xattr -cr "/Applications/Video Mapper.app"
     ```
- **Windows** : `VideoMapper-Installer-….exe` installe l'app, `…-Windows-x64.zip` est une version portable. Au premier lancement, Windows affiche un avertissement : cliquez sur « Informations complémentaires » puis « Exécuter quand même ».
- **Linux** : rendez le fichier `.AppImage` exécutable (`chmod +x`), puis lancez-le.

Ce que la version de bureau apporte par rapport au navigateur :
- choix de l'écran de sortie (le vidéoprojecteur), en plein écran et sans bordure ;
- son activé sans clic ;
- écran maintenu allumé pendant la projection ;
- option « Ouvrir la sortie au démarrage » ;
- menus et raccourcis : ⌘B pour le noir, ⌘P pour tout lire, ⌘K pour la calibration, etc.

## Utiliser la version web

Ouvrez https://bibliogironde.github.io/video-mapper/ dans Chrome ou Edge, ou lancez-la en local :

```sh
cd app
python3 -m http.server 8080      # puis ouvrir http://localhost:8080
```

Le dossier `app/` contient aussi `lancer-mac-linux.command` et `lancer-windows.bat`, qui font la même chose.

## Développer

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```sh
npm install
npm start                 # lance l'application de bureau
npm run dist:mac          # construit pour macOS (sur un Mac)
npm run dist:win          # construit pour Windows (installeur : nécessite Wine hors de Windows)
npm run dist:win-portable # version Windows portable, constructible depuis un Mac
npm run dist:linux        # construit l'AppImage Linux
```

### Publier une nouvelle version

Augmentez `version` dans `package.json` (par exemple `1.1.0`), puis faites un commit et un push sur `main` :

```sh
git commit -am "Version 1.1.0"
git push
```

GitHub Actions construit alors les versions Mac, Windows et Linux, puis les publie dans *Releases* sous le nom `v1.1.0` (workflow `.github/workflows/release.yml`). On peut aussi le lancer à la main depuis l'onglet *Actions*. La version web est republiée à chaque modification de `app/` (workflow `.github/workflows/pages.yml`).

### Organisation du code

| Fichier | Rôle |
|---|---|
| `app/index.html`, `app/js/editor.js` | Écran d'édition |
| `app/sortie.html`, `app/js/output.js` | Écran de projection |
| `app/js/engine.js` | Rendu p5.js (WebGL) commun aux deux écrans : surfaces p5.mapper, cadrage, découpe des cercles, repères de calibration |
| `app/js/store.js` | État du projet, médiathèque (IndexedDB), synchronisation entre fenêtres (`BroadcastChannel`), actions clavier |
| `app/js/photo.js` | Outil « calques depuis une photo » (OpenCV.js, homographie photo → projecteur) |
| `main.js`, `preload.js` | Application Electron : protocole `app://`, fenêtres, écrans, menus |

### Préparer une vidéo avec transparence

```sh
ffmpeg -framerate 25 -i frame_%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 4M sortie.webm
ffmpeg -i source.mov -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 4M -c:a libopus sortie.webm
```

Des médias de test sont fournis dans `app/exemples/`.

## Licence

Le code est sous licence MIT (voir `LICENSE`). Les bibliothèques incluses dans `app/lib/` gardent leur propre licence :
- p5.js : LGPL-2.1 ;
- p5.mapper : MIT ;
- OpenCV.js : Apache-2.0.
