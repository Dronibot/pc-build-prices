@echo off
rem Оновлення цін з домашнього комп'ютера (Geizhals блокує сервери GitHub).
rem Запускається Планувальником Windows кожні 2 години.
chcp 65001 >nul
cd /d "%~dp0.."
rem якщо попередній запуск перервався (сон/вимкнення) посеред rebase — прибрати його
git rebase --abort >nul 2>&1
git fetch -q
git rebase -q -X theirs origin/main > local-update.log 2>&1 || git rebase --abort >nul 2>&1
node scripts\update.mjs >> local-update.log 2>&1
git add data/*.json
git diff --cached --quiet || git commit -q -m "Оновлення цін (домашній ПК)"
for /L %%i in (1,1,3) do (
  git push -q >> local-update.log 2>&1 && goto :done
  git fetch -q
  git rebase -q -X theirs origin/main >> local-update.log 2>&1 || git rebase --abort >nul 2>&1
)
:done
