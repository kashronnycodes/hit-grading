from typing import Literal

from pydantic import BaseModel


class ImageInfo(BaseModel):
    width: int
    height: int


class OcrRegion(BaseModel):
    text: str
    confidence: float
    box: list[list[float]]


class OcrSuccess(BaseModel):
    success: Literal[True] = True
    provider: Literal["paddleocr"] = "paddleocr"
    processingMs: int
    image: ImageInfo
    regions: list[OcrRegion]


class OcrFailure(BaseModel):
    success: Literal[False] = False
    provider: Literal["paddleocr"] = "paddleocr"
    error: str
    message: str
