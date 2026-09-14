import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image
import easyocr


def run_adb(adb: str, args: list[str], stdout=None) -> subprocess.CompletedProcess:
    return subprocess.run([adb, *args], check=True, stdout=stdout, stderr=subprocess.PIPE)


def capture_screen(adb: str, output: Path) -> None:
    with output.open("wb") as handle:
        run_adb(adb, ["exec-out", "screencap", "-p"], stdout=handle)


def scaled_box(width: int, height: int, box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    base_w, base_h = 1440, 3200
    x1, y1, x2, y2 = box
    return (
        round(x1 * width / base_w),
        round(y1 * height / base_h),
        round(x2 * width / base_w),
        round(y2 * height / base_h),
    )


def normalize_heart_text(text: str) -> str:
    text = text.replace("一", "-").replace("—", "-").replace("–", "-")
    text = text.replace("次分", "次/分").replace("次/分", "次/分")
    text = re.sub(r"\s+", "", text)
    return text


def parse_values(texts: list[str]) -> dict:
    joined = "\n".join(normalize_heart_text(text) for text in texts)
    ranges = re.findall(r"(\d{2,3})-(\d{2,3})次/?分", joined)
    singles = re.findall(r"(?<![-\d])(\d{2,3})次/?分", joined)
    times = re.findall(r"\d{1,2}[.:]\d{2}-\d{1,2}[.:]\d{2}", joined)

    result: dict = {
        "rawText": texts,
        "normalizedText": joined,
        "ranges": [{"min": int(a), "max": int(b)} for a, b in ranges],
        "singleBpm": [int(value) for value in singles],
        "timeRanges": times,
    }
    if result["ranges"]:
        result["todayRange"] = result["ranges"][0]
    if result["singleBpm"]:
        result["averageBpm"] = result["singleBpm"][0]
    return result


def read_regions(image_path: Path, work_dir: Path) -> dict:
    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    regions = {
        "todayOverview": (50, 2150, 1050, 2450),
        "selectedBubble": (480, 600, 960, 850),
    }

    reader = easyocr.Reader(["ch_sim", "en"], gpu=False, verbose=False)
    region_results = {}
    all_texts: list[str] = []
    for name, base_box in regions.items():
        box = scaled_box(width, height, base_box)
        crop_path = work_dir / f"mi_health_{name}.png"
        image.crop(box).save(crop_path)
        ocr_results = reader.readtext(str(crop_path), detail=1, paragraph=False)
        texts = [str(item[1]) for item in ocr_results]
        all_texts.extend(texts)
        region_results[name] = {
            "box": box,
            "crop": str(crop_path),
            "texts": texts,
            "details": [
                {
                    "text": str(item[1]),
                    "confidence": float(item[2]),
                }
                for item in ocr_results
            ],
        }

    parsed = parse_values(all_texts)
    return {
        "image": str(image_path),
        "screen": {"width": width, "height": height},
        "regions": region_results,
        "parsed": parsed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read Xiaomi Health heart-rate page via screenshot OCR.")
    parser.add_argument("--adb", default=os.environ.get("ADB", "adb"))
    parser.add_argument("--image", help="Use an existing screenshot instead of capturing from adb.")
    parser.add_argument("--out", default="tmp/mi_health_heart_rate_ocr.json")
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = out_path.parent
    image_path = Path(args.image) if args.image else work_dir / "mi_health_heart_rate_screen.png"

    if args.image is None:
        capture_screen(args.adb, image_path)

    result = read_regions(image_path, work_dir)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["parsed"], ensure_ascii=False, indent=2))
    print(f"saved: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
