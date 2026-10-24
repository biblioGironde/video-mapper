@echo off
cd /d "%~dp0"
start "" http://localhost:8080/index.html
echo Video Mapper : http://localhost:8080/index.html  (fermer cette fenetre pour arreter)
py -m http.server 8080 || python -m http.server 8080
