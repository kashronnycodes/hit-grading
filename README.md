# HIT Grading

## Local Development

Optional pricing provider:

```powershell
$env:SCRYDEX_ENABLED="false"
$env:SCRYDEX_API_KEY=""
$env:SCRYDEX_TEAM_ID=""
```

Keep Scrydex off unless you have a confirmed account/API key. The backend now uses local fallback data + TCGdex for identification, then uses Scrydex only for high-confidence pricing.

Start the backend with Node's system certificate store enabled:

```powershell
node --use-system-ca .\node_modules\tsx\dist\cli.mjs watch server/src/index.ts
```

Start the frontend:

```powershell
node .\node_modules\vite\bin\vite.js --host 0.0.0.0
```

Open the app on this computer:

```text
http://127.0.0.1:5173/?debug
```

Open the app on a phone on the same Wi-Fi:

```text
http://192.168.1.140:5173/?debug
```
