#!/usr/bin/env python3
"""Render the six Telegram caption-style previews using ReelBot's real ASS pipeline."""
from pathlib import Path
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner

OUTPUT = ROOT / "assets" / "caption-previews"
STYLES = ["shifted", "clean", "glass_bar", "cream_bar", "outlined", "karaoke_yellow"]
GROUP = {
    "start": 0.15,
    "end": 1.4,
    "words": ["Сильное", "начало", "меняет", "весь", "ролик"],
    "wordTimes": [
        {"word": "Сильное", "start": 0.15, "end": 0.38},
        {"word": "начало", "start": 0.38, "end": 0.64},
        {"word": "меняет", "start": 0.64, "end": 0.96},
        {"word": "весь", "start": 0.96, "end": 1.12},
        {"word": "ролик", "start": 1.12, "end": 1.4},
    ],
}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for style_id in STYLES:
        subtitle_text = runner.make_ass(
            [GROUP], style_id, plate_opacity=60, font_id="montserrat", caption_accent="yellow"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".ass", encoding="utf-8", delete=False) as ass_file:
            ass_file.write(subtitle_text)
            ass_path = Path(ass_file.name)
        output_path = OUTPUT / f"{style_id}.jpg"
        video_filter = (
            f"subtitles=filename='{ass_path}':fontsdir='{ROOT / 'assets' / 'fonts'}',"
            "scale=540:960:flags=lanczos"
        )
        try:
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=0x53616E:s=1080x1920:r=25:d=1.5",
                    "-ss", "0.80", "-vf", video_filter, "-frames:v", "1", "-q:v", "3",
                    str(output_path),
                ],
                check=True,
            )
        finally:
            ass_path.unlink(missing_ok=True)
        print(f"created {output_path.relative_to(ROOT)} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
