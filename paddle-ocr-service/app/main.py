import asyncio
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse

from .image_utils import decode_image
from .ocr_engine import OcrEngine
from .schemas import ImageInfo, OcrFailure, OcrSuccess

engine: OcrEngine | None = None
ocr_slots = asyncio.Semaphore(max(1, int(os.getenv("PADDLE_OCR_CONCURRENCY", "1"))))


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    engine = await asyncio.to_thread(OcrEngine)
    yield
    engine = None


app = FastAPI(title="HIT Grading PaddleOCR", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok" if engine else "starting", "provider": "paddleocr", "modelLoaded": engine is not None}


@app.post("/ocr", response_model=OcrSuccess, responses={422: {"model": OcrFailure}, 503: {"model": OcrFailure}})
async def ocr(
    image: UploadFile = File(...),
    language: str | None = Form(default=None),
    scanId: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
):
    del language, scanId
    expected_key = os.getenv("PADDLE_OCR_API_KEY", "")
    if expected_key and authorization != f"Bearer {expected_key}":
        return JSONResponse(status_code=401, content=OcrFailure(error="UNAUTHORIZED", message="OCR authorization failed.").model_dump())
    if engine is None:
        return JSONResponse(status_code=503, content=OcrFailure(error="MODEL_NOT_READY", message="PaddleOCR is still starting.").model_dump())
    try:
        content = await image.read()
        decoded, width, height = decode_image(content, image.content_type)
    except ValueError as exc:
        return JSONResponse(status_code=422, content=OcrFailure(error=str(exc), message="The uploaded image is not supported.").model_dump())

    started = time.perf_counter()
    try:
        async with ocr_slots:
            regions = await asyncio.to_thread(engine.recognize, decoded)
    except Exception:
        return JSONResponse(status_code=503, content=OcrFailure(error="OCR_FAILED", message="PaddleOCR could not extract usable text.").model_dump())
    return OcrSuccess(
        processingMs=round((time.perf_counter() - started) * 1000),
        image=ImageInfo(width=width, height=height),
        regions=regions,
    )
