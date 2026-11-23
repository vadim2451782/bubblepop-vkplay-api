# Платёжный бэкенд «Лопни пузыри» для VK Play

Один файл: main.ts. Работает на Deno Deploy.

Эндпоинты:
- POST /create-payment — { productId, uid } → { url, merchantParam }
- GET /callback — уведомление VK Play, отвечает {"status":"ok"}
- GET /health — проверка

Переменные окружения (Deno Deploy → Project → Settings → Environment Variables):
- VKPLAY_SECRET — секрет из «Системных свойств» проекта VK Play
- VKPLAY_GMRID — 52062
- ALLOWED_ORIGIN — https://vadim2451782.github.io

Деплой: Deno Deploy → New Project → Deploy from GitHub → этот репозиторий,
entry point main.ts, регион — Europe.
