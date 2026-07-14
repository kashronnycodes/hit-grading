from io import BytesIO

import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


def decode_image(content: bytes, content_type: str | None) -> tuple[np.ndarray, int, int]:
    if content_type not in SUPPORTED_MIME_TYPES:
        raise ValueError("UNSUPPORTED_IMAGE_TYPE")
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("IMAGE_SIZE_INVALID")
    try:
        with Image.open(BytesIO(content)) as source:
            source.load()
            width, height = source.size
            if width < 80 or height < 80 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("IMAGE_DIMENSIONS_INVALID")
            rgb = source.convert("RGB")
            return np.asarray(rgb), width, height
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("INVALID_IMAGE") from exc
