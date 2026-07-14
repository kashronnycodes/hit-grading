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
npm run dev:api
```

Start the frontend:

```powershell
npm run dev -- --host 0.0.0.0
```

Open the app on this computer:

```text
http://127.0.0.1:5173/?debug
```

## Mobile Local Testing

Fast path:

```powershell
npm run dev:mobile
```

This starts the backend and frontend together, prints detected LAN IP addresses, and prints exact phone URLs.

If the app page stays blank on a phone, test without Vite HMR/WebSocket:

```powershell
npm run dev:mobile:no-hmr
```

You can also run the network doctor without starting servers:

```powershell
npm run network:doctor
```

1. Find the laptop IPv4 address:

```powershell
ipconfig
```

Look for the Wi-Fi adapter IPv4, for example:

```text
192.168.1.152
```

2. Keep the backend running:

```powershell
npm run dev:api
```

3. Keep the frontend running on all network interfaces:

```powershell
npm run dev -- --host 0.0.0.0
```

4. Open the app on a phone on the same Wi-Fi:

```text
http://<laptop-ip>:5173
```

Example:

```text
http://192.168.1.152:5173
```

Hard diagnostic order:

1. Open the static test page on the phone:

```text
http://<laptop-ip>:5173/mobile-test.html
```

This page does not depend on React, app JavaScript bundles, HMR, OCR, card detection, or the main UI. If the phone cannot open this page, the issue is outside the app code.

2. Open the API health URL on the phone:

```text
http://<laptop-ip>:5173/api/health
```

If this works through port `5173`, Vite's proxy is reaching the backend.

3. Open the backend network-info URL on the phone:

```text
http://<laptop-ip>:5173/api/network-info
```

This returns request host/origin/remote-address details for local debugging.

4. Only after those work, open the React app:

```text
http://<laptop-ip>:5173
```

The frontend normally calls the backend through Vite's same-origin `/api` proxy, so you usually do not need `VITE_API_BASE_URL`.

If you want the phone browser to call the backend directly, set:

```powershell
$env:VITE_API_BASE_URL="http://<laptop-ip>:8787"
npm run dev -- --host 0.0.0.0
```

The backend allows localhost plus private LAN Vite origins in development. For stricter local testing, set `CLIENT_ORIGIN` to a comma-separated list:

```powershell
$env:CLIENT_ORIGIN="http://127.0.0.1:5173,http://localhost:5173,http://<laptop-ip>:5173"
```

5. If the phone cannot load the page:

- Make sure phone and laptop are on the same Wi-Fi, not guest Wi-Fi.
- Make sure Windows network profile is Private, not Public.
- Allow Node.js or ports `5173` and `8787` through Windows Firewall.
- Disable VPN, iCloud Private Relay, or Limit IP Address Tracking while testing.
- Check the router for AP Isolation, Client Isolation, Wireless Isolation, or Guest Isolation.
- Try opening `http://<laptop-ip>:5173/api/health` on the phone.
- Try another phone or another laptop on the same Wi-Fi.
- Connect the laptop to the phone hotspot, rerun `npm run network:doctor`, and try the new IP.
- As a short test only, temporarily disable Windows Private firewall, retry `/mobile-test.html`, then turn the firewall back on.

If `/mobile-test.html` fails from the phone but works from the laptop LAN URL, the problem is not React, OCR, backend code, Vite proxy, or the card scanning feature. It is almost certainly firewall, router client isolation, guest Wi-Fi isolation, VPN/private relay, or device network separation.

6. Camera note:

```text
Some mobile browsers require HTTPS for camera access. Gallery upload still works over local HTTP. For camera testing on a phone, use localhost on the phone, an HTTPS tunnel, or a deployed HTTPS preview.
```

## Vercel Frontend Preview

This project can deploy the React/Vite frontend to Vercel as a static app. The OCR/backend Express server is not deployed to Vercel in this phase; it should stay as a separate backend service later.

Vercel settings:

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
```

The repo includes `vercel.json` with a single-page-app fallback so refreshed frontend routes load `index.html`.

Frontend environment variables:

```text
VITE_API_BASE_URL=
VITE_USE_MOCK_SCAN=false
VITE_MOCK_SCAN_STATE=identified
VITE_SHOW_DEPLOY_DIAGNOSTICS=false
```

Use `VITE_API_BASE_URL` only after the backend is deployed separately, for example:

```text
VITE_API_BASE_URL=https://your-backend-service.onrender.com
```

Do not put private API keys in `VITE_` variables. Anything starting with `VITE_` is bundled into browser code. Keep Scrydex, Pokemon API, Supabase service role, and other secrets on the backend only.

Mock mobile UI testing:

```text
VITE_USE_MOCK_SCAN=true
```

Optional mock result states:

```text
VITE_MOCK_SCAN_STATE=identified
VITE_MOCK_SCAN_STATE=needs_better_photo
VITE_MOCK_SCAN_STATE=needs_confirmation
VITE_MOCK_SCAN_STATE=userConfirmed
```

You can also override the state from the Vercel URL:

```text
https://your-vercel-preview.vercel.app/?mockState=needs_better_photo
```

Mock mode is frontend-only and clearly labels results as mock/dev only. It does not call OCR, card databases, pricing providers, Scrydex, or the backend.

For frontend-only Vercel testing before the backend is deployed, use:

```text
VITE_USE_MOCK_SCAN=true
VITE_SHOW_DEPLOY_DIAGNOSTICS=true
VITE_API_BASE_URL=
```

Deployment steps:

1. Push the repo to GitHub.
2. Import the GitHub repo into Vercel.
3. Select the Vite framework preset.
4. Confirm build command `npm run build`.
5. Confirm output directory `dist`.
6. Leave `VITE_API_BASE_URL` blank until the backend is deployed.
7. Set `VITE_USE_MOCK_SCAN=true` for phone UI testing without a backend.
8. Open the Vercel preview URL on your phone.

### Vercel Blank Page Troubleshooting

If the Vercel URL shows only the dark background:

1. Check the Vercel build logs and confirm `npm run build` passed.
2. Open the browser console on desktop and look for a React/runtime error.
3. Set this Vercel environment variable and redeploy:

```text
VITE_SHOW_DEPLOY_DIAGNOSTICS=true
```

4. For frontend-only testing without a backend, set these and redeploy:

```text
VITE_USE_MOCK_SCAN=true
VITE_SHOW_DEPLOY_DIAGNOSTICS=true
VITE_API_BASE_URL=
```

5. Only set `VITE_API_BASE_URL` after the backend is deployed separately:

```text
VITE_API_BASE_URL=https://your-backend-service.example.com
```

6. Redeploy after every Vercel environment variable change.

The app has a top-level error boundary. If React crashes, it should show a visible error panel instead of only the background. Deployment diagnostics show current origin, API base URL, mock mode, build mode, and API health status.

## Pokemon identification deployment

Pokemon identification now uses the persistent PaddleOCR service first, local Pokemon cache/TCGdex matching second, and one Scrydex Vision fallback only for an unreliable Paddle-derived match. Tesseract remains installed for experiments but is disabled by `TESSERACT_OCR_ENABLED=false` and is loaded dynamically only when explicitly enabled.

See [paddle-ocr-service/README.md](paddle-ocr-service/README.md) for exact Render setup, environment variables, memory guidance, health checks, service connectivity, and rollback steps.

Local verification:

```powershell
npm run build:api
npm run test:identification
```
