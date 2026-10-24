#!/bin/sh
# Lance un petit serveur local puis ouvre l'éditeur.
cd "$(dirname "$0")"
PORT=8080
( sleep 1; (open "http://localhost:$PORT/index.html" 2>/dev/null || xdg-open "http://localhost:$PORT/index.html") ) &
echo "Video Mapper : http://localhost:$PORT/index.html  (Ctrl+C pour arrêter)"
python3 -m http.server $PORT
