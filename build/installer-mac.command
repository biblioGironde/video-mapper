#!/bin/sh
# Video Mapper — installation sur Mac Apple Silicon
# Copie l'app dans Applications, retire la quarantaine et la signe localement
# (signature « ad hoc »), de l'intérieur vers l'extérieur, puis la lance.
cd "$(dirname "$0")"
SRC="Video Mapper.app"
APP="/Applications/Video Mapper.app"
[ -d "$SRC" ] || { echo "« $SRC » introuvable à côté de ce script."; exit 1; }

echo "1/5 Copie dans Applications…"
rm -rf "$APP"
cp -R "$SRC" /Applications/ || { echo "Échec de la copie"; exit 1; }
xattr -cr "$APP"

echo "2/5 Signature des bibliothèques et exécutables internes…"
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -perm -111 \) | while read -r f; do
  if file "$f" | grep -q "Mach-O"; then codesign --force --sign - --timestamp=none "$f" 2>&1 | grep -v "replacing existing signature"; fi
done
echo "3/5 Signature des frameworks et apps auxiliaires…"
for b in "$APP/Contents/Frameworks/"*.framework "$APP/Contents/Frameworks/"*.app; do
  codesign --force --sign - --timestamp=none "$b" 2>&1 | grep -v "replacing existing signature"
done
echo "4/5 Signature de l'application…"
codesign --force --sign - --timestamp=none "$APP" 2>&1 | grep -v "replacing existing signature"

echo "5/5 Vérification…"
if codesign --verify --deep --strict "$APP" 2>/tmp/vm-verify.txt; then echo "   Signature valide."; else echo "   ⚠"; cat /tmp/vm-verify.txt; fi

"$APP/Contents/MacOS/Video Mapper" > /tmp/vm-launch.txt 2>&1 &
PID=$!
sleep 6
if kill -0 $PID 2>/dev/null; then
  echo "✅ Video Mapper tourne. Ouvrez-la ensuite normalement depuis Applications."
  disown $PID 2>/dev/null
else
  echo "❌ L'app s'est arrêtée. Messages à transmettre :"
  head -40 /tmp/vm-launch.txt; echo "---"; uname -m; sw_vers
fi
