# HIT Grading PaddleOCR Service

This private FastAPI service loads English PP-OCRv5 once at startup and reuses it for CPU OCR requests. It exposes `GET /health` and multipart `POST /ocr`.

## Local run

```powershell
cd paddle-ocr-service
docker build -t hit-paddle-ocr .
docker run --rm -p 8000:8000 hit-paddle-ocr
```

The first image build/start downloads PaddleOCR model assets. Confirm `GET http://127.0.0.1:8000/health` returns `modelLoaded: true` before sending scans.

## Render: PaddleOCR private service

1. Create a new Render **Private Service** from this repository.
2. Set the root directory to `paddle-ocr-service` and runtime to Docker.
3. Use the Dockerfile as-is; it starts one Uvicorn worker so the model is loaded once.
4. Set the health check path to `/health`.
5. Optionally set `PADDLE_OCR_CONCURRENCY=1` (the default). Raise it only after measuring memory and latency.
6. Wait for the health response to report `modelLoaded: true`.
7. Copy the service's private Render URL for the Node service. Do not expose this URL to Vercel or the browser.

PaddlePaddle plus PP-OCRv5 may exceed a 512 MB instance during model startup or inference. Use at least 1 GB RAM as a practical starting point, observe Render's peak memory, and move to a larger instance if the service restarts or is OOM-killed. Do not add Uvicorn workers to improve throughput: each worker loads another model copy.

## Render: existing Node API

Keep the existing build/start commands:

```text
Build: npm install && npm run build:api
Start: npm run start:api
```

Set these environment variables on the Node service:

```text
PADDLE_OCR_ENABLED=true
PADDLE_OCR_ENDPOINT=http://<private-paddle-service-host>:<port>
PADDLE_OCR_TIMEOUT_MS=12000
PADDLE_OCR_MATCH_THRESHOLD=0.85
TESSERACT_OCR_ENABLED=false
SCRYDEX_VISION_FALLBACK_ENABLED=true
SCRYDEX_VISION_TIMEOUT_MS=12000
SCRYDEX_VISION_MATCH_THRESHOLD=0.85
SCRYDEX_API_BASE_URL=https://api.scrydex.com
SCRYDEX_API_KEY=<backend-only secret>
SCRYDEX_TEAM_ID=<backend-only secret>
```

`PADDLE_OCR_API_KEY` is optional for a protected OCR endpoint. Keep all provider secrets on Render; do not create `VITE_` versions. The Node health endpoint reports only enabled/reachable booleans and never the private URL or credentials.

Set the Node health check to `/api/health`. Allow enough startup time for the separate OCR service to download/load its model. Node requests time out independently after `PADDLE_OCR_TIMEOUT_MS`; failed or weak Paddle identification can make one Scrydex Vision call.

## Rollback

1. Set `PADDLE_OCR_ENABLED=false` and `SCRYDEX_VISION_FALLBACK_ENABLED=false` to stop both new providers immediately and return controlled manual search responses.
2. Redeploy the previous Node commit if the response orchestration itself must be reverted.
3. Leave `TESSERACT_OCR_ENABLED=false` during rollback unless an explicitly approved experiment requires the legacy path.
4. Stop or suspend the Paddle private service after Node no longer references it.

No production secrets are stored in this directory.
