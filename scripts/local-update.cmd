@echo off
rem Оновлення цін з домашнього комп'ютера (Geizhals блокує сервери GitHub).
rem Запускається Планувальником Windows кожні 2 години.
chcp 65001 >nul
cd /d "%~dp0.."
git pull --rebase --autostash -q
node scripts\update.mjs > local-update.log 2>&1
git add data/*.json
git diff --cached --quiet || git commit -q -m "Оновлення цін (домашній ПК)"
git push -q >> local-update.log 2>&1
