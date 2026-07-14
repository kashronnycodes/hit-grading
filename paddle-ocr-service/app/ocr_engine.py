from __future__ import annotations

import threading
from typing import Any

from paddleocr import PaddleOCR


class OcrEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ocr = PaddleOCR(
            lang="en",
            ocr_version="PP-OCRv5",
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            device="cpu",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )

    def recognize(self, image: Any) -> list[dict[str, Any]]:
        with self._lock:
            results = self._ocr.predict(image)
        regions: list[dict[str, Any]] = []
        for result in results:
            payload = result.json if hasattr(result, "json") else result
            if callable(payload):
                payload = payload()
            data = payload.get("res", payload) if isinstance(payload, dict) else {}
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            boxes = data.get("rec_polys", data.get("dt_polys", []))
            for text, score, box in zip(texts, scores, boxes):
                clean = str(text).strip()
                confidence = float(score)
                if clean and confidence >= 0.25:
                    regions.append({
                        "text": clean,
                        "confidence": confidence,
                        "box": [[float(point[0]), float(point[1])] for point in box],
                    })
        return regions
