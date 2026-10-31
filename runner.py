#!/usr/bin/env python3
"""ReelBot runner: забирает заказ у Worker, монтирует ролик, отправляет в Telegram.

Запускается GitHub Actions каждые 5 минут (см. .github/workflows/runner.yml).
Нужны переменные окружения: GATEWAY_URL, TELEGRAM_BOT_TOKEN.
Необязательно: ANTHROPIC_API_KEY (разбор хука с вариантами), WHISPER_MODEL, HOOK_MODEL.
"""
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests
from PIL import ImageFont

GATEWAY = os.environ.get("GATEWAY_URL", "").rstrip("/")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
HOOK_MODEL = os.environ.get("HOOK_MODEL", "claude-sonnet-5-5")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
MAX_OUT = 49 * 1024 * 1024
TIME_BUDGET = 40 * 60
MAX_ATTEMPTS = 3

# ---------- Стили субтитров ----------
FONT_DIR = os.path.join(os.path.dirname(__file__), "assets", "fonts")
CAPTION_FONTS = {
    "inter": {"name": "Inter", "path": os.path.join(FONT_DIR, "Inter[opsz,wght].ttf"), "axes": [14, 700]},
    "montserrat": {"name": "Montserrat", "path": os.path.join(FONT_DIR, "Montserrat[wght].ttf"), "axes": [700]},
    "oswald": {"name": "Oswald", "path": os.path.join(FONT_DIR, "Oswald[wght].ttf"), "axes": [700]},
}
DEFAULT_CAPTION_FONT = "montserrat"

STYLES = {
    "glass": dict(label="Glass", plate="000000", op=0.6, text="FFFFFF", key="none", bold=False),
    "powder": dict(label="Powder", plate="E8B8C8", op=0.95, text="FFFFFF", key="none"),
    "fuchsia": dict(label="Fuchsia", plate="181018", op=0.75, text="FFFFFF", key="plate", key_plate="FF4FA3", key_text="FFFFFF"),
    "olive": dict(label="Olive", plate="2F3924", op=0.85, text="FFFFFF", key="plate", key_plate="C6D59A", key_text="2F3924"),
    "echo": dict(label="Echo", plate="202020", op=0.54, text="FFFFFF", key="none", echo=True),
    "mixed": dict(label="Mixed Key Words", plate="202020", op=0.6, text="FFFFFF", key="word", accents=["FF4FA3", "F2D44E"]),
    "shifted": dict(label="Бордовая со сдвигом", plate="4A0D25", op=0.6, text="FFFFFF", key="none", custom="shifted", font_size=62),
    "clean": dict(label="Белый текст без плашки", plate="000000", op=0.0, text="FFFFFF", key="none", custom="clean", font_size=62),
    "karaoke_yellow": dict(label="Белая фраза + жёлтое активное слово", plate="000000", op=0.0, text="FFFFFF", key="none", custom="accent", accent="FFD84D", font_size=64),
    "karaoke_pink": dict(label="Белая фраза + розовое активное слово", plate="000000", op=0.0, text="FFFFFF", key="none", custom="accent", accent="FF4FA3", font_size=64),
    "karaoke_red": dict(label="Белая фраза + красное активное слово", plate="000000", op=0.0, text="FFFFFF", key="none", custom="accent", accent="F04452", font_size=64),
    "glass_bar": dict(label="Тёмная прозрачная плашка", plate="24212B", op=0.6, text="FFFFFF", key="none", custom="glass", font_size=60),
}


class UserError(Exception):
    """Ошибка, текст которой можно показать пользователю."""


# ---------- Связь с Worker ----------
def gw(path, **kw):
    r = requests.post(GATEWAY + path, headers={"authorization": f"Bearer {TOKEN}"}, timeout=300, **kw)
    if not r.ok:
        raise RuntimeError(f"{path}: {r.status_code} {r.text[:200]}")
    return r


def say(chat_id, text):
    try:
        gw("/runner/message", json={"chatId": chat_id, "text": text})
    except Exception as exc:  # сообщение не должно ронять монтаж
        print("не удалось отправить сообщение:", exc)


# ---------- Утилиты ----------
def run(cmd, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} завершился с кодом {p.returncode}: {p.stderr[-1200:]}")
    return p


def safe_name(name):
    return re.sub(r"[^a-zA-Z0-9._-]", "_", os.path.basename(name)) or "video.mp4"


def probe_duration(path):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path])
    try:
        v = float(p.stdout.strip())
    except ValueError:
        return 0.0
    return v if math.isfinite(v) and v > 0 else 0.0


def has_audio(path):
    p = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path], check=False)
    return bool(p.stdout.strip())


# ---------- Скачивание ----------
def direct_url(raw):
    u = urlparse(raw)
    host = (u.hostname or "").lower()
    if host.endswith("dropbox.com"):
        if u.path.startswith(("/scl/fo/", "/sh/")):
            raise UserError("Это ссылка на папку Dropbox. Пришли ссылки на отдельные видеофайлы.")
        q = dict(parse_qsl(u.query))
        q["dl"] = "1"
        return urlunparse(u._replace(query=urlencode(q)))
    if host == "1drv.ms" or host.endswith("onedrive.live.com"):
        enc = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
        return f"https://api.onedrive.com/v1.0/shares/u!{enc}/root/content"
    if host.endswith("sharepoint.com"):
        q = dict(parse_qsl(u.query))
        q["download"] = "1"
        return urlunparse(u._replace(query=urlencode(q)))
    return raw


_counter = [0]


def download(src, workdir):
    _counter[0] += 1
    out = os.path.join(workdir, f"src-{_counter[0]}-{safe_name(src.get('name', 'video.mp4'))}")
    if src.get("url"):
        r = requests.get(direct_url(src["url"]), stream=True, allow_redirects=True, timeout=180)
        if not r.ok:
            raise UserError(f"Ссылка не скачалась (код {r.status_code}). Проверь, что доступ открыт «всем, у кого есть ссылка».")
        if "text/html" in r.headers.get("content-type", ""):
            raise UserError("Ссылка открывает страницу, а не файл. Нужна прямая ссылка на видео с разрешением скачивания.")
    elif src.get("fileId"):
        r = requests.post(GATEWAY + "/runner/file", headers={"authorization": f"Bearer {TOKEN}"}, json={"fileId": src["fileId"]}, stream=True, timeout=180)
        if r.status_code == 413:
            raise UserError("Файл больше 20 МБ. Отправь ссылку Dropbox или OneDrive.")
        if not r.ok:
            raise UserError("Не удалось скачать видео из Telegram. Если оно больше 20 МБ, отправь ссылку Dropbox или OneDrive.")
    else:
        raise UserError("У исходника нет ни файла, ни ссылки.")
    with open(out, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    if os.path.getsize(out) < 1024:
        raise UserError("Скачался пустой файл. Проверь ссылку.")
    return out


# ---------- Подготовка видео ----------
def normalize(src, dst):
    cmd = ["ffmpeg", "-y", "-i", src]
    if not has_audio(src):
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest"]
    cmd += ["-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", dst]
    run(cmd)


def join_sources(paths, workdir):
    normalized = []
    for i, p in enumerate(paths):
        dst = os.path.join(workdir, f"norm-{i}.mp4")
        normalize(p, dst)
        normalized.append(dst)
    if len(normalized) == 1:
        return normalized[0]
    lst = os.path.join(workdir, "concat.txt")
    with open(lst, "w") as f:
        for p in normalized:
            f.write("file '" + p.replace("'", "'\\''") + "'\n")
    out = os.path.join(workdir, "joined.mp4")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    return out


def remove_pauses(path, workdir):
    """Вырезает длинную тишину (как в CapCut): тишина от 0.35 с, по краям оставляем 0.08 с."""
    duration = probe_duration(path)
    if not duration:
        return path
    diag = run(["ffmpeg", "-hide_banner", "-i", path, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"], check=False).stderr
    silences, pending = [], None
    for kind, val in re.findall(r"silence_(start|end):\s*(-?[\d.]+)", diag):
        v = max(0.0, float(val))
        if kind == "start":
            pending = v
        elif pending is not None:
            silences.append((pending, v))
            pending = None
    if pending is not None:
        silences.append((pending, duration))
    if not silences:
        return path
    intervals, cursor = [], 0.0
    for start, end in silences:
        keep_end = max(cursor, start - 0.08)
        if keep_end - cursor > 0.15:
            intervals.append((cursor, keep_end))
        cursor = min(duration, end + 0.08)
    if duration - cursor > 0.15:
        intervals.append((cursor, duration))
    if len(intervals) < 2:
        return path
    parts, labels = [], ""
    for i, (a, b) in enumerate(intervals):
        parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]")
        labels += f"[v{i}][a{i}]"
    parts.append(f"{labels}concat=n={len(intervals)}:v=1:a=1[v][a]")
    script = os.path.join(workdir, "cut.txt")
    with open(script, "w") as f:
        f.write(";\n".join(parts))
    out = os.path.join(workdir, "cleaned.mp4")
    run(["ffmpeg", "-y", "-i", path, "-filter_complex_script", script, "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", out])
    return out


# ---------- Речь ----------
def transcribe(path, workdir):
    from faster_whisper import WhisperModel

    wav = os.path.join(workdir, "audio.wav")
    run(["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav])
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segs, _ = model.transcribe(wav, language="ru", word_timestamps=True, condition_on_previous_text=False, vad_filter=True)
    out = []
    for s in segs:
        words = [{"start": w.start, "end": w.end, "word": w.word.strip()} for w in (s.words or []) if w.word.strip()]
        out.append({"start": s.start, "end": s.end, "text": s.text.strip(), "words": words})
    return out


CAPTION_MAX_WORDS = 9
CAPTION_TARGET_WORDS = 7
CAPTION_TARGET_SECONDS = 1.9
CAPTION_MAX_SECONDS = 3.0
CAPTION_PAUSE_SECONDS = 0.65
CAPTION_MIN_SECONDS = 0.35
CAPTION_MIN_GROUP_WORDS = 3
CAPTION_MAX_LINE_CHARS = 30
CAPTION_WEAK_WORDS = {
    "а", "и", "но", "что", "чтобы", "к", "ко", "в", "во", "на", "с", "со", "по", "за",
    "из", "от", "до", "о", "об", "обо", "при", "для", "у", "без", "над", "под", "про",
    "же", "ли", "бы", "то",
}


def _caption_token_key(text):
    return re.sub(r"[^0-9A-Za-zА-Яа-яЁё]+", "", str(text)).casefold()


def _caption_sentence_end(text):
    value = str(text).strip().lower()
    if re.search(r"(?:т\.д\.|т\.е\.|т\.к\.|др\.)$", value):
        return False
    return bool(re.search(r"[.!?…]+[\"'»”)]*$", value))


def _caption_clause_end(text):
    return bool(re.search(r"[,;:]+[\"'»”)]*$", str(text).strip()))


def _caption_is_weak_word(text):
    return _caption_token_key(text) in CAPTION_WEAK_WORDS


def _caption_capitalize(text):
    return re.sub(r"[A-Za-zА-Яа-яЁё]", lambda m: m.group(0).upper(), str(text), count=1)


def _caption_segment_words(seg):
    text = str(seg.get("text") or "").strip()
    try:
        seg_start = float(seg.get("start", 0.0))
        seg_end = float(seg.get("end", seg_start))
    except (TypeError, ValueError):
        seg_start, seg_end = 0.0, 0.0
    if not math.isfinite(seg_start):
        seg_start = 0.0
    if not math.isfinite(seg_end):
        seg_end = seg_start
    seg_start = max(0.0, seg_start)

    raw = [w for w in (seg.get("words") or []) if isinstance(w, dict)]
    text_tokens = text.split()
    if raw and len(text_tokens) == len(raw) and all(
        _caption_token_key(token) == _caption_token_key(word.get("word", ""))
        for token, word in zip(text_tokens, raw)
    ):
        # When Whisper's segment text and timed words match, keep its punctuation/casing.
        raw = [{**word, "word": token} for token, word in zip(text_tokens, raw)]

    result = []
    if raw:
        for item in raw:
            token = str(item.get("word") or "").strip()
            if not token:
                continue
            try:
                start = float(item.get("start", seg_start))
                end = float(item.get("end", start))
            except (TypeError, ValueError):
                continue
            if not math.isfinite(start) or not math.isfinite(end):
                continue
            start = max(0.0, start)
            end = max(start + 0.03, end)
            if not _caption_token_key(token) and result:
                result[-1]["word"] += token
                result[-1]["end"] = max(result[-1]["end"], end)
                continue
            result.append({"start": start, "end": end, "word": token})
        return result

    if not text_tokens:
        return []
    duration = max(0.0, seg_end - seg_start)
    step = duration / len(text_tokens) if duration > 0 else 0.35
    for i, token in enumerate(text_tokens):
        start = seg_start + i * step
        result.append({"start": start, "end": max(start + 0.03, start + step), "word": token})
    return result


def group_words(segments):
    """Группирует речь в читаемые фразы: до 9 слов, обычно 6–9 слов и 2–3 секунды."""
    words = []
    for seg in segments:
        words.extend(_caption_segment_words(seg))
    words.sort(key=lambda w: (w["start"], w["end"]))

    sentence_start = True
    for item in words:
        if sentence_start:
            item["word"] = _caption_capitalize(item["word"])
        sentence_start = _caption_sentence_end(item["word"])

    groups, current = [], []

    def make_group(items):
        stored = list(items)
        start = stored[0]["start"]
        end = max(stored[-1]["end"], start + CAPTION_MIN_SECONDS)
        tokens = [word["word"] for word in stored]
        word_times = [{"word": word["word"], "start": word["start"], "end": word["end"]} for word in stored]
        return {"start": start, "end": end, "words": tokens, "text": " ".join(tokens), "wordTimes": word_times, "_items": stored}

    def flush():
        if not current:
            return
        groups.append(make_group(current))
        current.clear()

    for word in words:
        if not current:
            current.append(word)
            if _caption_sentence_end(word["word"]):
                flush()
            continue

        previous = current[-1]
        count = len(current)
        elapsed = previous["end"] - current[0]["start"]
        gap = max(0.0, word["start"] - previous["end"])
        sentence_break = _caption_sentence_end(previous["word"])
        should_break = sentence_break or count >= CAPTION_MAX_WORDS
        if not should_break:
            should_break = (
                (gap >= CAPTION_PAUSE_SECONDS and count >= 2)
                or (count >= CAPTION_TARGET_WORDS and elapsed >= CAPTION_TARGET_SECONDS)
                or (_caption_clause_end(previous["word"]) and count >= 5 and elapsed >= 1.8)
                or (count >= 4 and elapsed >= CAPTION_MAX_SECONDS)
            )
        if should_break and not sentence_break and count < CAPTION_MAX_WORDS and _caption_is_weak_word(previous["word"]):
            should_break = False
        if should_break:
            carry = None
            if not sentence_break and count >= CAPTION_MAX_WORDS and _caption_is_weak_word(previous["word"]) and count > 1:
                carry = current.pop()
            flush()
            if carry:
                current.append(carry)

        current.append(word)
        count = len(current)
        elapsed = current[-1]["end"] - current[0]["start"]
        if _caption_sentence_end(word["word"]):
            flush()
        elif count >= CAPTION_MAX_WORDS:
            if _caption_is_weak_word(word["word"]) and count > 1:
                carry = current.pop()
                flush()
                current.append(carry)
            else:
                flush()
        elif count >= CAPTION_TARGET_WORDS and elapsed >= CAPTION_TARGET_SECONDS and not _caption_is_weak_word(word["word"]):
            flush()
        elif count >= 4 and elapsed >= CAPTION_MAX_SECONDS and not _caption_is_weak_word(word["word"]):
            flush()

    flush()
    # Rebalance a short tail from the same spoken phrase (e.g. 9+1 -> 7+3).
    # Keep real sentence boundaries and pauses intact.
    i = 1
    while i < len(groups):
        previous_group, group = groups[i - 1], groups[i]
        previous_items, items = previous_group["_items"], group["_items"]
        gap = items[0]["start"] - previous_items[-1]["end"]
        if (len(items) >= CAPTION_MIN_GROUP_WORDS
                or gap >= CAPTION_PAUSE_SECONDS
                or _caption_sentence_end(previous_items[-1]["word"])):
            i += 1
            continue

        combined = previous_items + items
        duration = combined[-1]["end"] - combined[0]["start"]
        if len(combined) <= CAPTION_MAX_WORDS and duration <= CAPTION_MAX_SECONDS:
            groups[i - 1] = make_group(combined)
            del groups[i]
            i = max(1, i - 1)
            continue

        move = min(CAPTION_MIN_GROUP_WORDS - len(items), max(0, len(previous_items) - CAPTION_MIN_GROUP_WORDS))
        if move > 0:
            groups[i - 1] = make_group(previous_items[:-move])
            groups[i] = make_group(previous_items[-move:] + items)
            if len(groups[i]["_items"]) < CAPTION_MIN_GROUP_WORDS:
                continue
        i += 1

    for i, group in enumerate(groups[:-1]):
        next_start = groups[i + 1]["start"]
        if next_start > group["start"]:
            group["end"] = min(group["end"], next_start)
    for group in groups:
        group.pop("_items", None)
    return groups


def apply_caption_edits(groups, edits):
    """Replace only the caption phrase nearest to a user-specified output time."""
    result = [dict(group, words=list(group.get("words", [])), wordTimes=list(group.get("wordTimes", []))) for group in groups]
    for edit in edits or []:
        try:
            at = float(edit["at"])
            replacement = str(edit["text"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not replacement or not result:
            continue
        target = min(result, key=lambda group: abs((float(group["start"]) + float(group["end"])) / 2 - at))
        tokens = replacement.split()
        target["words"] = tokens
        target["text"] = " ".join(tokens)
        target["wordTimes"] = []
    return result


def wrap_caption_words(words, max_chars=CAPTION_MAX_LINE_CHARS):
    """Chooses a balanced two-line break and avoids leaving a short word at line end."""
    tokens = [str(w).strip() for w in words if str(w).strip()]
    if not tokens:
        return []
    if len(" ".join(tokens)) <= max_chars:
        return [tokens]

    best_split, best_score = None, None
    for split in range(1, len(tokens)):
        left, right = tokens[:split], tokens[split:]
        left_text, right_text = " ".join(left), " ".join(right)
        if len(left_text) > max_chars + 8 or len(right_text) > max_chars + 8:
            continue
        score = abs(len(left_text) - len(right_text)) + 5 * abs(len(left) - len(right))
        if _caption_is_weak_word(left[-1]):
            score += 100
        if _caption_clause_end(left[-1]):
            score -= 4
        if len(left) == 1 or len(right) == 1:
            score += 8
        if best_score is None or score < best_score:
            best_split, best_score = split, score
    if best_split is None:
        best_split = max(1, len(tokens) // 2)
    return [tokens[:best_split], tokens[best_split:]]


# ---------- Субтитры (ASS) ----------
def ass_time(sec):
    sec = max(0.0, sec)
    h, m, s = int(sec // 3600), int((sec % 3600) // 60), sec % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def ass_text(text):
    return re.sub(r"[{}\\]", "", text).replace("\n", "\\N").strip()


def ass_color(hex_, opacity=1.0):
    a = f"{round((1 - opacity) * 255):02X}"
    return f"&H{a}{hex_[4:6]}{hex_[2:4]}{hex_[0:2]}".upper()


def ass_bgr(hex_):
    return f"&H{hex_[4:6]}{hex_[2:4]}{hex_[0:2]}&".upper()


def style_line(name, text, plate, opacity, bold=True, font_name="DejaVu Sans", secondary=None):
    return (f"Style: {name},{font_name},58,{ass_color(text)},{ass_color(secondary or text)},{ass_color(plate, opacity)},"
            f"{ass_color('000000', 0.5)},{-1 if bold else 0},0,0,0,100,100,0,0,3,18,0,2,90,90,430,1")


def caption_text_style_line(st, font_name="DejaVu Sans"):
    """ASS text without a full-line plate; use a compact black outline and light shadow."""
    size = st.get("font_size", 60)
    alignment = 5 if st.get("custom") == "shifted" else 2
    margin_v = 0 if alignment == 5 else 430
    return (f"Style: Base,{font_name},{size},{ass_color(st['text'])},{ass_color(st.get('accent') or st['text'])},"
            f"{ass_color('000000')},{ass_color('000000', 0)},-1,0,0,0,100,100,0,0,1,1.5,0.8,"
            f"{alignment},70,70,{margin_v},1")


def caption_font_config(font_id=None):
    return CAPTION_FONTS.get(font_id or DEFAULT_CAPTION_FONT, CAPTION_FONTS[DEFAULT_CAPTION_FONT])


def _caption_text_width(text, font_size, font_path=None):
    font_path = font_path or "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    try:
        font = ImageFont.truetype(font_path, font_size)
        if hasattr(font, "get_variation_axes"):
            values = []
            for axis in font.get_variation_axes():
                axis_name = axis.get("name", b"").decode("ascii", "ignore").lower()
                value = 700 if axis_name == "weight" else axis.get("default", 0)
                values.append(max(axis.get("minimum", value), min(axis.get("maximum", value), value)))
            if values:
                font.set_variation_by_axes(values)
        return int(math.ceil(font.getlength(text)))
    except Exception:
        return int(math.ceil(len(text) * font_size * 0.58))


def _rounded_rect_path(width, height, radius):
    r = max(1, min(radius, width // 2, height // 2))
    k = round(r * 0.55228475, 2)
    return (f"m {r} 0 l {width-r} 0 "
            f"b {width-r+k} 0 {width} {r-k} {width} {r} "
            f"l {width} {height-r} b {width} {height-r+k} {width-r+k} {height} {width-r} {height} "
            f"l {r} {height} b {r-k} {height} 0 {height-r+k} 0 {height-r} "
            f"l 0 {r} b 0 {r-k} {r-k} 0 {r} 0")


def shifted_caption_events(group, wrapped, st, anchor=None, font_path=None):
    """Draw one rounded, semi-transparent berry card, offset behind the phrase."""
    lines = [" ".join(line) for line in wrapped if line]
    if not lines:
        return []
    size = st.get("font_size", 60)
    width = min(980, max(170, max(_caption_text_width(line, size, font_path) for line in lines) + 44))
    height = len(lines) * int(size * 1.18) + 24
    cx, cy = anchor or (540, 1410)
    x = max(30, min(1080 - width - 30, int(cx - width / 2 + 18)))
    y = max(240, min(1600 - height, int(cy - height / 2 + 9)))
    path = _rounded_rect_path(width, height, 24)
    start, end = ass_time(group["start"]), ass_time(group["end"])
    color = ass_bgr(st["plate"])
    alpha = f"{round((1 - st.get('op', 0.92)) * 255):02X}"
    shape = (f"Dialogue: 0,{start},{end},Base,,0,0,0,,"
             f"{{\\an7\\pos({x},{y})\\p1\\bord0\\shad0\\1c{color}\\1a&H{alpha}&}}{path}{{\\p0}}")
    text = ass_text("\n".join(lines))
    caption = (f"Dialogue: 1,{start},{end},Base,,0,0,0,,"
               f"{{\\an5\\pos({cx},{cy})}}{text}")
    return [shape, caption]


def glass_caption_events(group, wrapped, st, anchor=None, font_path=None):
    """Draw an even, rounded dark glass bar with no offset."""
    lines = [" ".join(line) for line in wrapped if line]
    if not lines:
        return []
    size = st.get("font_size", 60)
    width = min(980, max(170, max(_caption_text_width(line, size, font_path) for line in lines) + 56))
    height = len(lines) * int(size * 1.18) + 24
    cx, cy = anchor or (540, 1410)
    x, y = max(30, int(cx - width / 2)), max(240, min(1640 - height, int(cy - height / 2)))
    start, end = ass_time(group["start"]), ass_time(group["end"])
    color = ass_bgr(st["plate"])
    alpha = f"{round((1 - st.get('op', 0.6)) * 255):02X}"
    shape = (f"Dialogue: 0,{start},{end},Base,,0,0,0,,"
             f"{{\\an7\\pos({x},{y})\\p1\\bord0\\shad0\\1c{color}\\1a&H{alpha}&}}{_rounded_rect_path(width, height, min(30, height // 2))}{{\\p0}}")
    text = "\\N".join(ass_text(line) for line in lines)
    caption = f"Dialogue: 1,{start},{end},Base,,0,0,0,,{{\\an5\\pos({cx},{cy})}}{text}"
    return [shape, caption]


def _word_intervals(group, words):
    """Use Whisper's exact word boundaries; edited text falls back to even phrase timing."""
    start, end = float(group["start"]), max(float(group["end"]), float(group["start"]) + 0.04)
    timed = group.get("wordTimes") or []
    if len(timed) == len(words):
        intervals = []
        for item in timed:
            a = max(start, float(item.get("start", start)))
            b = min(end, max(a + 0.02, float(item.get("end", a + 0.02))))
            intervals.append((a, b))
        return intervals
    span = max(0.04, end - start)
    step = span / max(1, len(words))
    return [(start + i * step, start + (i + 1) * step) for i in range(len(words))]


def active_word_events(group, wrapped, st, anchor=None):
    """Overlay one phrase-aligned word at a time in the selected accent color."""
    if not st.get("accent"):
        return []
    words = [word for line in wrapped for word in line]
    intervals = _word_intervals(group, words)
    start, end = ass_time(group["start"]), ass_time(group["end"])
    pos = f"{{\\an5\\pos({anchor[0]},{anchor[1]})}}" if anchor else ""
    accent = ass_bgr(st["accent"])
    events = []
    for active, (word_start, word_end) in enumerate(intervals):
        rich_lines, index = [], 0
        for line_words in wrapped:
            rendered = []
            for word in line_words:
                safe = ass_text(word)
                if index == active:
                    rendered.append(f"{{\\1a&H00&\\1c{accent}\\3a&HFF&\\4a&HFF&}}{safe}")
                else:
                    rendered.append(f"{{\\1a&HFF&\\3a&HFF&\\4a&HFF&}}{safe}")
                index += 1
            rich_lines.append(" ".join(rendered))
        rich_text = "\\N".join(rich_lines)
        events.append(f"Dialogue: 2,{ass_time(word_start)},{ass_time(word_end)},Base,,0,0,0,,{pos}{rich_text}")
    return events


CAPTION_ANCHORS = {
    "bottom": (540, 1450),
    "top": (540, 350),
    "top_left": (300, 420),
    "top_right": (780, 420),
    "left": (270, 1020),
    "right": (810, 1020),
    "bottom_left": (300, 1480),
    "bottom_right": (780, 1480),
}


def detect_caption_positions(path, groups, mode="auto"):
    """Пробует найти лицо и ставит каждую фразу в более свободную безопасную зону.

    Анализ локальный и необязательный; если OpenCV/каскад недоступен или лицо
    не найдено, возвращается пустой список, и make_ass оставляет старую позицию.
    """
    if mode in ("top", "bottom"):
        return [CAPTION_ANCHORS[mode]] * len(groups)
    if mode != "auto" or not groups or len(groups) > 600:
        return [None] * len(groups)
    try:
        import cv2
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        detector = cv2.CascadeClassifier(cascade_path)
        if detector.empty():
            return [None] * len(groups)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return [None] * len(groups)
    except Exception:
        return [None] * len(groups)

    zones = ["bottom", "top", "left", "right", "bottom_left", "bottom_right", "top_left", "top_right"]
    positions, previous_zone = [], None
    for index, group in enumerate(groups):
        t = max(0.0, (float(group["start"]) + float(group["end"])) / 2.0)
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            positions.append(None)
            continue
        small = cv2.resize(frame, (270, 480), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        faces = detector.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(24, 24))
        if len(faces) == 0:
            positions.append(None)
            continue

        # Увеличиваем рамку лица, чтобы подпись не прилегала вплотную к голове.
        occupied = []
        for x, y, w, h in faces:
            occupied.append((max(0, x * 4 - 100), max(0, y * 4 - 110),
                              min(1080, (x + w) * 4 + 100), min(1920, (y + h) * 4 + 250)))
        words = group.get("words") or group.get("text", "").split()
        wrapped = wrap_caption_words(words)
        lines = [" ".join(line) for line in wrapped if line]
        width = min(900, max(190, max((_caption_text_width(line, 58) for line in lines), default=280) + 70))
        height = max(100, len(lines) * 76 + 24)
        # При равной безопасности порядок зон меняется от фразы к фразе, но лицо всегда важнее.
        ordered = zones[index % len(zones):] + zones[:index % len(zones)]
        scored = []
        for zone in ordered:
            cx, cy = CAPTION_ANCHORS[zone]
            rect = (cx - width // 2, cy - height // 2, cx + width // 2, cy + height // 2)
            overlap = 0.0
            for ax1, ay1, ax2, ay2 in occupied:
                ix = max(0, min(rect[2], ax2) - max(rect[0], ax1))
                iy = max(0, min(rect[3], ay2) - max(rect[1], ay1))
                overlap += (ix * iy) / max(1, width * height)
            # Стараемся не ставить текст в самые верхние/нижние интерфейсные зоны.
            edge_penalty = 0.35 if rect[1] < 240 or rect[3] > 1640 else 0.0
            stability_penalty = 0.12 if zone != previous_zone else 0.0
            scored.append((overlap * 100 + edge_penalty + stability_penalty, zone, (cx, cy)))
        score, zone, anchor = min(scored, key=lambda item: item[0])
        if score >= 100:
            positions.append(None)
        else:
            positions.append(anchor)
            previous_zone = zone
    cap.release()
    return positions


def is_key(group, index):
    return index == 0 or (index % 3 == 0 and max(len(w) for w in group["words"]) >= 6)


def plate_style_line(st, font_name="DejaVu Sans"):
    """Плашка с текстом: сверху по центру, цвета берём из выбранного стиля субтитров."""
    plate = st.get("key_plate") or st["plate"]
    text = st.get("key_text") or st["text"]
    return (f"Style: Plate,{font_name},54,{ass_color(text)},{ass_color(text)},{ass_color(plate, 0.95)},"
            f"{ass_color('000000', 0.5)},-1,0,0,0,100,100,0,0,3,20,0,8,90,90,250,1")


def make_ass(groups, style_id, plates=None, positions=None, plate_opacity=None, font_id=None):
    st = dict(STYLES[style_id])
    if plate_opacity is not None and st.get("custom") not in ("clean", "accent"):
        st["op"] = max(0.2, min(0.8, float(plate_opacity) / 100.0))
    font = caption_font_config(font_id)
    font_name, font_path = font["name"], font["path"]
    base_style = caption_text_style_line(st, font_name) if st.get("custom") else style_line("Base", st["text"], st["plate"], st["op"], bold=st.get("bold", True), font_name=font_name, secondary=st.get("accent"))
    styles = [base_style, plate_style_line(st, font_name)]
    if st["key"] == "plate":
        styles.append(style_line("Key", st["key_text"], st["key_plate"], 0.95, bold=st.get("bold", True), font_name=font_name))
    header = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
              "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
              "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
              "MarginL, MarginR, MarginV, Encoding\n" + "\n".join(styles) + "\n\n[Events]\nFormat: Layer, Start, End, Style, "
              "Name, MarginL, MarginR, MarginV, Effect, Text\n")
    lines = []
    for pl in plates or []:
        ptext = ass_text(pl["text"])
        if ptext:
            lines.append(f"Dialogue: 2,{ass_time(pl['at'])},{ass_time(pl['at'] + pl['dur'])},Plate,,0,0,0,,{{\\fad(150,150)}}{ptext}")
    for i, g in enumerate(groups):
        words = g.get("words") or g.get("text", "").split()
        wrapped = wrap_caption_words(words, max_chars=24 if st.get("custom") else CAPTION_MAX_LINE_CHARS)
        display_text = "\n".join(" ".join(line) for line in wrapped)
        s, e, text = ass_time(g["start"]), ass_time(g["end"]), ass_text(display_text)
        anchor = positions[i] if positions and i < len(positions) else None
        pos = f"{{\\an5\\pos({anchor[0]},{anchor[1]})}}" if anchor else ""
        if st.get("custom") == "shifted":
            lines.extend(shifted_caption_events(g, wrapped, st, anchor, font_path))
            lines.extend(active_word_events(g, wrapped, st, anchor))
            continue
        if st.get("custom") == "glass":
            lines.extend(glass_caption_events(g, wrapped, st, anchor, font_path))
            lines.extend(active_word_events(g, wrapped, st, anchor))
            continue
        if st.get("custom") == "accent":
            lines.append(f"Dialogue: 1,{s},{e},Base,,0,0,0,,{pos}{text}")
            lines.extend(active_word_events(g, wrapped, st, anchor))
            continue
        if st.get("echo"):
            if anchor:
                lines.append(f"Dialogue: 0,{s},{e},Base,,0,0,0,,{{\\an5\\pos({anchor[0]},{anchor[1] - 24})\\alpha&H99&}}{text}")
                lines.append(f"Dialogue: 1,{s},{e},Base,,0,0,0,,{pos}{text}")
            else:
                lines.append(f"Dialogue: 0,{s},{e},Base,,0,0,0,,{{\\pos(540,1466)\\alpha&H99&}}{text}")
                lines.append(f"Dialogue: 1,{s},{e},Base,,0,0,0,,{{\\pos(540,1490)}}{text}")
            continue
        if st["key"] == "word":
            accent = st["accents"][i % len(st["accents"])]
            lines.append(f"Dialogue: 0,{s},{e},Base,,0,0,0,,{pos}{{\\1a&HFF&}}{text}")
            rich_lines, word_index = [], 0
            for line_words in wrapped:
                rendered = []
                for word in line_words:
                    safe_word = ass_text(word)
                    if word_index == 0:
                        rendered.append(f"{{\\3a&HFF&\\1c{ass_bgr(accent)}}}{safe_word}{{\\1c{ass_bgr(st['text'])}}}")
                    else:
                        rendered.append(safe_word)
                    word_index += 1
                rich_lines.append(" ".join(rendered))
            rich_text = "\\N".join(rich_lines)
            lines.append(f"Dialogue: 1,{s},{e},Base,,0,0,0,,{pos}{rich_text}")
            continue
        name = "Key" if st["key"] == "plate" and is_key(g, i) else "Base"
        lines.append(f"Dialogue: 0,{s},{e},{name},,0,0,0,,{pos}{text}")
    return header + "\n".join(lines) + "\n"


# ---------- Зум ----------
def analyze_reference_zoom(video_path):
    """Смотрит референс по кадрам и находит наезды камеры: когда, насколько, как быстро, сколько держался."""
    import cv2
    import numpy as np

    # Приводим референс к постоянным 12 кадрам/с и маленькому размеру: записи экрана телефона
    # имеют переменную частоту кадров, и без этого анализ считает время неверно.
    # Запись экрана (очень вытянутый кадр) обрезаем до области самого ролика, без интерфейса телефона.
    probe = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video_path], check=False)
    try:
        pw, ph = [int(x) for x in probe.stdout.strip().split(",")[:2]]
    except ValueError:
        pw, ph = 1080, 1920
    crop = "crop=iw*0.78:ih*0.60:0:ih*0.11," if ph / max(pw, 1) > 2.05 else ""
    small = video_path + ".ref.mp4"
    run(["ffmpeg", "-y", "-i", video_path, "-an", "-vf", f"{crop}fps=12,scale=320:-2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", small])
    video_path = small
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    step = max(1, int(round(fps / 12.0)))
    orb = cv2.ORB_create(600)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    prev_kp = prev_des = None
    samples, i = [], 0
    while True:
        if not cap.grab():
            break
        if i % step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            h, w = frame.shape[:2]
            small = cv2.cvtColor(cv2.resize(frame, (320, max(1, int(h * 320.0 / w)))), cv2.COLOR_BGR2GRAY)
            kp, des = orb.detectAndCompute(small, None)
            scale = None
            if prev_des is not None and des is not None and len(des) > 20 and len(prev_des) > 20:
                m = bf.match(prev_des, des)
                if len(m) > 20:
                    a = np.float32([prev_kp[x.queryIdx].pt for x in m])
                    b = np.float32([kp[x.trainIdx].pt for x in m])
                    M, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=3)
                    if M is not None and inl is not None and inl.sum() >= 15 and inl.sum() / len(m) > 0.4:
                        scale = float(math.hypot(M[0, 0], M[1, 0]))
            samples.append((i / fps, scale))
            prev_kp, prev_des = kp, des
        i += 1
    cap.release()
    duration = (total / fps) if total else (i / fps)
    raw, cur = [], None
    for idx in range(1, len(samples)):
        t, s = samples[idx]
        if s is None or abs(math.log(s)) < 0.02:
            if cur:
                raw.append(cur)
                cur = None
            continue
        d = 1 if s > 1 else -1
        if cur and cur["dir"] == d:
            cur["amp"] *= s
            cur["end"] = t
        else:
            if cur:
                raw.append(cur)
            cur = {"t": samples[idx - 1][0], "amp": s, "end": t, "dir": d}
    if cur:
        raw.append(cur)
    events = []
    for k, ev in enumerate(raw):
        if ev["dir"] < 0 or ev["amp"] < 1.03:
            continue
        out = next((e for e in raw[k + 1:] if e["dir"] < 0), None)
        nin = next((e for e in raw[k + 1:] if e["dir"] > 0), None)
        end_limit = min([x["t"] for x in (out, nin) if x] + [ev["end"] + 3.0])
        events.append({"t": round(ev["t"], 2), "amp": round(min(max(ev["amp"], 1.03), 1.30), 3),
                       "ramp": round(max(0.08, ev["end"] - ev["t"]), 2), "hold": round(max(0.3, end_limit - ev["end"]), 2)})
    return {"duration": round(duration, 2) or 1.0, "events": events[:60]}


def default_zoom_events(groups, duration):
    """Зумы по всему ролику, без референса. Ритм: наезд в начале фразы каждые ~2 с,
    сила и тип меняются по кругу: резкий наезд, медленный подъезд, мягкий наезд, пауза без зума.
    Хук (первая фраза) получает самый сильный наезд."""
    if not groups:
        return []
    beats, last = [], None
    for i, g in enumerate(groups):
        if last is None or g["start"] - last >= 1.8:
            beats.append(g["start"])
            last = g["start"]
    end_of_video = max(duration, groups[-1]["end"])
    patterns = [  # (сила, время набора, тип)
        (0.12, 0.10, "punch"),
        (0.08, None, "push"),
        (0.07, 0.12, "punch"),
        (0.0, 0.0, "rest"),
        (0.15, 0.08, "punch"),
        (0.06, None, "push"),
    ]
    events = []
    for k, t in enumerate(beats):
        nxt = beats[k + 1] if k + 1 < len(beats) else end_of_video
        length = max(0.5, nxt - t)
        amp, ramp, kind = (0.16, 0.08, "punch") if k == 0 else patterns[(k - 1) % len(patterns)]
        if kind == "rest":
            continue
        if kind == "push":
            events.append({"t": t, "amp": amp, "ramp": max(0.5, length * 0.95), "hold": 0.0, "out": 0.12})
        else:
            events.append({"t": t, "amp": amp, "ramp": ramp, "hold": max(0.3, length - ramp - 0.15), "out": 0.12})
    return events


def zoom_expression(groups, profile, video_duration, camera_mode="standard"):
    """Выражение масштаба для ffmpeg.
    С референсом: те же наезды (сила, скорость, удержание), прижатые к ближайшему слову.
    Без референса: зумы по всему ролику (см. default_zoom_events)."""
    if camera_mode == "none":
        return "1"
    strength = 1.45 if camera_mode == "boosted" else 1.0
    if profile and profile["events"] and video_duration > 0:
        events, offset = [], 0.0
        while offset < video_duration and len(events) < 120:
            for ev in profile["events"]:
                start = ev["t"] + offset
                if start >= video_duration:
                    break
                near = min(groups, key=lambda g: abs(g["start"] - start), default=None)
                snapped = near["start"] if near and abs(near["start"] - start) <= 0.6 else start
                events.append({**ev, "amp": ev["amp"] - 1, "t": snapped, "out": ev["ramp"]})
            offset += profile["duration"]
    else:
        events = default_zoom_events(groups, video_duration)
    events = [{**event, "amp": float(event.get("amp", 0)) * strength} for event in events]
    terms = []
    for ev in events[:120]:
        ramp = max(0.06, ev["ramp"])
        out = max(0.06, ev.get("out", ramp))
        end = ev["t"] + ramp + ev["hold"]
        terms.append(f"{ev['amp']:.3f}*clip((t-{ev['t']:.2f})/{ramp:.2f},0,1)*(1-clip((t-{end:.2f})/{out:.2f},0,1))")
    return f"1+min(0.3,{'+'.join(terms)})" if terms else "1"


COLOR_FILTERS = {
    "original": "eq=saturation=1.08:contrast=1.04:brightness=0.02",
    "clean": "eq=saturation=1.0:contrast=1.0:brightness=0",
    "peach": "eq=saturation=1.10:contrast=1.02:brightness=0.025,colorbalance=rs=0.025:bs=-0.015",
    "soft": "eq=saturation=0.94:contrast=0.96:brightness=0.025",
    "cool": "eq=saturation=0.98:contrast=1.02:brightness=0.005,colorbalance=rs=-0.02:bs=0.035",
    "film": "eq=saturation=0.78:contrast=1.08:brightness=-0.005",
    "contrast": "eq=saturation=1.03:contrast=1.14:brightness=-0.015",
    "bright": "eq=saturation=1.03:contrast=1.02:brightness=0.035",
    "warm": "eq=saturation=1.10:contrast=1.02:brightness=0.015,colorbalance=rs=0.04:bs=-0.035",
}


def color_filter_expression(filter_id):
    return COLOR_FILTERS.get(str(filter_id or "original"), COLOR_FILTERS["original"])


# ---------- Вставки (гифки и видео поверх ролика) ----------
INSERT_DEFAULT_GIF = 2.5
INSERT_DEFAULT_VIDEO = 3.0
FADE = 0.12


def plan_inserts(inserts, groups, total):
    """Решает, когда и как долго показывать каждую вставку. Время считается по ГОТОВОМУ ролику (после вырезания пауз).
    Если время не задано, вставки равномерно раскладываются по ролику после хука (первые ~2.5 с не трогаем),
    прижимаются к началу ближайшей фразы и не накладываются на другие вставки."""
    planned = [dict(i) for i in inserts if i.get("path")]

    def length(item):
        kind = item.get("kind", "video")
        natural = probe_duration(item["path"]) or INSERT_DEFAULT_GIF
        default = INSERT_DEFAULT_GIF if kind == "gif" else min(INSERT_DEFAULT_VIDEO, natural)
        return item.get("dur") or default

    taken = [(float(i["at"]), float(i["at"]) + length(i)) for i in planned if i.get("at") is not None]
    auto = [i for i in planned if i.get("at") is None]
    start_zone = 2.5 if total > 6 else 1.0
    end_zone = max(start_zone, total - 1.5)
    for k, item in enumerate(auto):
        dur = length(item)
        slot = (end_zone - start_zone) / len(auto)
        t = start_zone + (k + 0.5) * slot - dur / 2
        near = min(groups, key=lambda g: abs(g["start"] - t), default=None)
        if near and abs(near["start"] - t) <= 1.0:
            t = near["start"]
        t = max(start_zone, t)
        for a, b in sorted(taken):
            if t < b and t + dur > a:
                t = b + 0.2
        item["at"] = t
        taken.append((t, t + dur))
    result = []
    for item in planned:
        kind = item.get("kind", "video")
        item["mode"] = item.get("mode") or ("overlay" if kind == "gif" else "full")
        dur = length(item)
        at = max(0.0, float(item["at"]))
        dur = min(dur, total - at - 0.2)
        if dur < 0.4:
            continue  # вставка не помещается в ролик
        item["at"], item["dur"] = round(at, 2), round(dur, 2)
        result.append(item)
    return result


def insert_inputs(planned):
    """Входные файлы для ffmpeg: каждая вставка зациклена и обрезана до своей длительности."""
    args = []
    for item in planned:
        args += ["-stream_loop", "-1", "-t", f"{item['dur']:.2f}", "-i", item["path"]]
    return args


def build_filter_graph(planned, base_chain, ass, fonts_dir=None):
    """Граф ffmpeg: основное видео (зум, цвет) → вставки по очереди → субтитры и плашки сверху."""
    parts = [f"[0:v]{base_chain}[b0]"]
    for n, item in enumerate(planned, start=1):
        at, dur = item["at"], item["dur"]
        if item["mode"] == "full":
            fit = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
            pos = "x=0:y=0"
        else:
            fit = "scale=720:720:force_original_aspect_ratio=decrease"
            pos = "x=(W-w)/2:y=230"
        parts.append(
            f"[{n}:v]fps=30,{fit},setsar=1,format=yuva420p,"
            f"fade=t=in:st=0:d={FADE}:alpha=1,fade=t=out:st={max(0.0, dur - FADE):.2f}:d={FADE}:alpha=1,"
            f"setpts=PTS-STARTPTS+{at:.2f}/TB[i{n}]")
        parts.append(f"[b{n - 1}][i{n}]overlay={pos}:enable='between(t,{at:.2f},{at + dur:.2f})':eof_action=pass[b{n}]")
    font_option = f":fontsdir='{fonts_dir}'" if fonts_dir else ""
    parts.append(f"[b{len(planned)}]subtitles=filename='{ass}'{font_option}[vout]")
    return ";\n".join(parts)


# ---------- Финальная сборка ----------
def render(path, segments, workdir, style_id, profile, inserts=None, plates=None, caption_position="auto", caption_edits=None,
           camera_mode="standard", color_filter="original", plate_opacity=None, font_id=None):
    groups = apply_caption_edits(group_words(segments), caption_edits or [])
    total = probe_duration(path)
    positions = detect_caption_positions(path, groups, caption_position)
    ass = os.path.join(workdir, "captions.ass")
    clean_plates = []
    for pl in plates or []:
        try:
            at, dur = max(0.0, float(pl["at"])), float(pl["dur"])
        except (KeyError, TypeError, ValueError):
            continue
        if pl.get("text") and at < total:
            clean_plates.append({"text": pl["text"], "at": at, "dur": max(0.8, min(dur, total - at))})
    with open(ass, "w", encoding="utf-8") as f:
        f.write(make_ass(groups, style_id, clean_plates, positions, plate_opacity, font_id))
    zoom = zoom_expression(groups, profile, total, camera_mode)
    base_chain = ",".join([
        "scale=1080:1920:force_original_aspect_ratio=increase",
        "crop=1080:1920",
        f"scale=w='trunc(1080*({zoom})/2)*2':h='trunc(1920*({zoom})/2)*2':eval=frame",
        "crop=1080:1920",
        color_filter_expression(color_filter),
    ])
    planned = plan_inserts(inserts or [], groups, total)
    graph = os.path.join(workdir, "graph.txt")
    fonts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "fonts")
    with open(graph, "w", encoding="utf-8") as f:
        f.write(build_filter_graph(planned, base_chain, ass, fonts_dir))
    out = os.path.join(workdir, "reelbot-result.mp4")
    run(["ffmpeg", "-y", "-i", path] + insert_inputs(planned) +
        ["-filter_complex_script", graph, "-map", "[vout]", "-map", "0:a", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out])
    if os.path.getsize(out) > MAX_OUT:
        small = os.path.join(workdir, "reelbot-small.mp4")
        run(["ffmpeg", "-y", "-i", out, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac",
             "-b:a", "96k", "-movflags", "+faststart", small])
        out = small
    if os.path.getsize(out) > MAX_OUT:
        tiny = os.path.join(workdir, "reelbot-tiny.mp4")
        run(["ffmpeg", "-y", "-i", out, "-vf", "scale=720:1280", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
             "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", tiny])
        out = tiny
    if os.path.getsize(out) > MAX_OUT:
        raise UserError("Готовый ролик получился больше 50 МБ, Telegram его не примет. Пришли исходники покороче.")
    return out


# ---------- Разбор хука ----------
def hook_text(segments, limit=4.0):
    words = [w for s in segments for w in s.get("words", []) if w["start"] < limit]
    if words:
        return " ".join(w["word"] for w in words)
    return segments[0]["text"] if segments else ""


def hook_heuristic(text, first_start):
    t = text.lower()
    score, notes = 3, []
    if first_start <= 0.8:
        score += 1
    else:
        notes.append("речь начинается не сразу")
    if "?" in text or re.search(r"\b(как|почему|зачем|что если|знаешь|а ты|а вы)\b", t):
        score += 2
    else:
        notes.append("нет вопроса или интриги")
    if re.search(r"\d", t):
        score += 1
    if re.search(r"\b(ты|тебе|тебя|вы|вам|вас|твой|ваш)\w*", t):
        score += 1
    else:
        notes.append("нет обращения к зрителю")
    if re.search(r"(никогда|ошибк|секрет|правда|стоп|не делай|перестань|шок|бесплатн)", t):
        score += 1
    if len(text.split()) > 18:
        score -= 1
        notes.append("слишком длинно")
    if re.match(r"^\W*(привет|всем привет|здравствуйте|сегодня я|в этом видео|друзья)", t):
        score -= 2
        notes.append("вялое приветствие в начале")
    return max(1, min(10, score)), notes


def hook_with_ai(full_text, first_text):
    prompt = (
        "Ты бережный редактор коротких вертикальных видео. Разбери только текст расшифровки: ты не видишь кадры, "
        "не знаешь реальных результатов и не проверял Instagram. Не считай вопрос обязательным признаком сильного хука. "
        "Хорошее начало может быть действием, личной историей, желанием, мифом с подтверждением или интригой. "
        "Оцени, понятна ли задача ролика, раскрывается ли обещание начала, логично ли речь ведёт к решению, "
        "есть ли настоящий показ/пруф и понятный призыв. Не выдумывай личный опыт, цифры, факты и доказательства.\n\n"
        f"Хук (первые секунды речи): «{first_text}»\n\nВся речь ролика:\n{full_text[:3000]}\n\n"
        "Ответь ТОЛЬКО JSON без пояснений: {\"score\": число 1-10, \"verdict\": \"сильный\" или \"слабый\", "
        "\"why\": \"1–2 коротких предложения\", \"structure\": \"понятно ли развитие мысли\", "
        "\"proof\": \"какого доказательства не хватает или что уже подтверждает слова\", "
        "\"flow\": \"где переход резкий или затянутый\", \"cta\": \"понятен ли призыв\", "
        "\"variants\": [\"вариант 1\", \"вариант 2\", \"вариант 3\"]}. "
        "Дай практичные замечания по схеме: задача → начало → проблема/желание → причина выбора → решение → демонстрация → доказательство → призыв. "
        "Не делай вид, что оценил картинку. Варианты начала — до 12 слов, оригинальные, без неподтверждённых обещаний. По-русски."
    )
    r = requests.post("https://api.anthropic.com/v1/messages", timeout=90,
                      headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                      json={"model": HOOK_MODEL, "max_tokens": 700, "messages": [{"role": "user", "content": prompt}]})
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json().get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0))


def script_with_ai(topic):
    if not ANTHROPIC_KEY:
        return ("Для создания персонального сценария нужен настроенный ИИ-редактор; сейчас он не подключён к этому запуску.\n\n"
                "Пока держи каркас: начало, которое обещает конкретную пользу → проблема или желание зрителя → "
                "почему ты выбрала решение → показ применения → реальное доказательство/результат → короткий призыв. "
                "Не добавляй цифры и личные истории, если их нельзя подтвердить. Бот не ищет в Instagram без отдельного источника.")
    prompt = (
        "Ты русскоязычный редактор коротких видео и сценарист коммерческих, UGC и обычных авторских роликов. "
        "Сначала определи одну задачу: продать, снять сомнение, показать эффект, объяснить, развлечь или рассказать историю. "
        "Для коммерческого видео выбери главную цель: продажа, ответ на возражение или демонстрация результата. "
        "Предложи разные типы начала: действие плюс любопытство; честная личная история; миф/спорное мнение с доказательством; "
        "конкретное желаемое изменение; сравнение или мини-проверка. Сильное начало не обязано быть вопросом. "
        "Веди зрителя связно: проблема/желание → причина выбора → решение → демонстрация → проверяемое доказательство → призыв. "
        "Можно показать «до/после» или повторить результат перед камерой. Не добавляй личную историю, свойства продукта или результат, "
        "о которых автор не сообщал. Текст должен звучать естественно, не как список рекламных преимуществ.\n\n"
        f"ТЕМА ПОЛЬЗОВАТЕЛЯ: {topic[:1200]}\n\n"
        "Сделай три разных начала, каждое до 12 слов и примерно на первые 1–3 секунды, с разными приёмами; объясни каждое одной фразой. "
        "К каждому началу предложи первое действие/изображение в кадре. Затем создай сценарий на 20–35 секунд и план кадров по шагам, "
        "который раскрывает обещание начала и не перескакивает к характеристикам до объяснения решения. "
        "Не копируй известные ролики и не заявляй, что искал Instagram. Не придумывай опыт автора, отзывы, числа, "
        "эффективность или свойства продукта. Если нужно личное/фактическое доказательство, обозначь его как [добавить только свой реальный пример]. "
        "Если тема слишком общая, явно напиши допущение, не задавай длинную анкету. Пиши простым русским языком.\n\n"
        "Ответь только JSON: {\"goal\":\"одна задача ролика\",\"hooks\":[{\"text\":\"...\",\"angle\":\"...\",\"why\":\"...\",\"first_frame\":\"действие или первый кадр\"}],"
        "\"scenario\":[{\"time\":\"0-3 сек\",\"say\":\"текст\",\"show\":\"что снять\"}],"
        "\"proof\":\"какое подтверждение нужно\",\"cta\":\"призыв\",\"assumptions\":\"допущения или пусто\"}"
    )
    r = requests.post("https://api.anthropic.com/v1/messages", timeout=90,
                      headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                      json={"model": HOOK_MODEL, "max_tokens": 1400, "messages": [{"role": "user", "content": prompt}]})
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json().get("content", []))
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("ИИ не вернул сценарий в ожидаемом формате")
    data = json.loads(match.group(0))
    hooks = data.get("hooks") if isinstance(data.get("hooks"), list) else []
    steps = data.get("scenario") if isinstance(data.get("scenario"), list) else []
    lines = [f"Задача ролика: {str(data.get('goal', 'показать пользу'))[:220]}", "", "Три варианта начала:"]
    for i, hook in enumerate(hooks[:3], 1):
        if isinstance(hook, dict):
            lines.append(f"{i}) {str(hook.get('text', ''))[:180]} — {str(hook.get('angle', ''))[:100]}. {str(hook.get('why', ''))[:150]}\nПервый кадр: {str(hook.get('first_frame', ''))[:150]}")
    lines.extend(["", "Сценарий и что показать:"])
    for step in steps[:7]:
        if isinstance(step, dict):
            lines.append(f"{str(step.get('time', ''))[:35]}: {str(step.get('say', ''))[:240]}\nКадр: {str(step.get('show', ''))[:180]}")
    if data.get("proof"):
        lines.extend(["", f"Доказательство: {str(data['proof'])[:350]}"])
    if data.get("cta"):
        lines.append(f"Призыв: {str(data['cta'])[:250]}")
    if data.get("assumptions"):
        lines.extend(["", f"Допущение: {str(data['assumptions'])[:250]}"])
    lines.extend(["", "Важно: это оригинальная заготовка по теме, не копия чужого ролика и не проверка Instagram. Факты и личный опыт нужно подтвердить."])
    return "\n".join(lines)[:3800]


def hook_message(segments):
    first = hook_text(segments)
    if not first.strip():
        return None
    first_start = min((w["start"] for s in segments for w in s.get("words", [])), default=0.0)
    full = " ".join(s["text"] for s in segments)
    if ANTHROPIC_KEY:
        try:
            d = hook_with_ai(full, first)
            variants = "\n".join(f"{i + 1}) {v}" for i, v in enumerate(d.get("variants", [])[:3]))
            return (f"Начало ролика: «{first}»\nПредварительная оценка текста: {d.get('score', '?')}/10 ({d.get('verdict', '')}); это не оценка картинки или успеха ролика.\n"
                    f"Почему: {d.get('why', '')}\nСтруктура: {d.get('structure', 'не удалось оценить')}\n"
                    f"Доказательство: {d.get('proof', 'не удалось оценить')}\nПереходы: {d.get('flow', 'не удалось оценить')}\n"
                    f"Призыв: {d.get('cta', 'не удалось оценить')}\n\n"
                    f"Другие варианты начала:\n{variants}\n\n"
                    "Оценивался только текст расшифровки: картинку бот не оценивал и чужие ролики в Instagram не искал.")
        except Exception as exc:
            print("разбор хука через ИИ не получился:", exc)
    _, notes = hook_heuristic(first, first_start)
    extra = ("\nНа что обратить внимание: " + ", ".join(notes) + ".") if notes else ""
    return (f"Хук: «{first}»\nПока могу дать только короткую предварительную проверку.{extra}\n"
            "Это не экспертная оценка и бот не искал похожие ролики в Instagram.")


def apply_speed(path, speed, workdir):
    """Change video tempo before transcription so caption times stay aligned; atempo preserves pitch."""
    try:
        speed = float(speed)
    except (TypeError, ValueError):
        raise UserError("Не удалось прочитать скорость ролика. Выбери её командой /speed.")
    allowed = (1.0, 1.1, 1.2, 1.3, 1.5)
    if not any(abs(speed - value) < 0.001 for value in allowed):
        raise UserError("Такой скорости нет. Выбери значение командой /speed.")
    if abs(speed - 1.0) < 0.001:
        return path
    output = os.path.join(workdir, "reelbot-speed.mp4")
    run(["ffmpeg", "-y", "-i", path, "-vf", f"setpts=PTS/{speed:.3f},fps=30", "-af", f"atempo={speed:.3f}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output])
    return output


def send_media_credits(chat, inserts):
    lines = []
    for item in inserts or []:
        if item.get("sourceName") != "Wikimedia Commons":
            continue
        title = str(item.get("name") or "Материал").strip()[:100]
        artist = str(item.get("artist") or "Автор не указан").strip()[:180]
        license_name = str(item.get("license") or "лицензия не указана").strip()[:80]
        source = str(item.get("sourceUrl") or item.get("url") or "").strip()[:500]
        license_url = str(item.get("licenseUrl") or "").strip()[:300]
        lines.append(f"• {title} — {artist}; {license_name}. Лицензия: {license_url}. Источник: {source}")
    if not lines:
        return
    prefix = "Источники и авторство использованных вставок (можно скопировать в описание ролика):\n\n"
    chunks, current = [], prefix
    for line in lines:
        if len(current) + len(line) + 2 > 3300 and current != prefix:
            chunks.append(current.rstrip())
            current = "Продолжение — источники и авторство:\n\n"
        current += line + "\n\n"
    if current.strip():
        chunks.append(current.rstrip())
    for chunk in chunks:
        try:
            say(chat, chunk)
        except Exception as exc:
            print("не удалось отправить список авторства:", exc)


# ---------- Одна задача ----------
def process(job):
    chat = job["chatId"]
    if job.get("kind") == "creative":
        say(chat, "Готовлю варианты начала и короткий сценарий по твоей теме.")
        try:
            message = script_with_ai(str(job.get("request", "")))
        except Exception as exc:
            print("не удалось подготовить сценарий:", exc)
            message = ("Не получилось подготовить сценарий через ИИ. Попробуй ещё раз чуть позже.\n\n"
                       "Пока пользуйся схемой: конкретное начало → проблема или желаемый результат → решение → "
                       "показ на камеру → настоящее доказательство → короткий призыв. Неподтверждённые обещания лучше не добавлять.")
        say(chat, message)
        gw("/runner/complete", json={"jobId": job["id"]})
        return

    style = job.get("style") if job.get("style") in STYLES else "shifted"
    workdir = tempfile.mkdtemp(prefix="reelbot-")
    try:
        sources = job.get("sources") or []
        say(chat, f"Начинаю монтаж {job['id']}. Стиль: {STYLES[style]['label']}. Исходников: {len(sources)}. "
                  f"Вставок: {len(job.get('inserts') or [])}, плашек: {len(job.get('plates') or [])}. "
                  f"Скорость ×{job.get('speed', 1)}; камера: {job.get('cameraMode', 'standard')}; фильтр: {job.get('colorFilter', 'original')}. "
                  "Скачиваю, убираю паузы, расшифровываю речь.")
        paths = [download(s, workdir) for s in sources]
        joined = join_sources(paths, workdir)
        cleaned = remove_pauses(joined, workdir)
        working = apply_speed(cleaned, job.get("speed", 1), workdir)
        segments = transcribe(working, workdir)
        if not any(s["text"] for s in segments):
            raise UserError("Не расслышала речь в видео. Проверь, что звук есть и голос слышно.")
        profile = None
        if job.get("reference"):
            try:
                profile = analyze_reference_zoom(download(job["reference"], workdir))
                say(chat, f"Референс разобран: нашла {len(profile['events'])} наездов камеры. Повторяю такой же зум."
                    if profile["events"] else "В референсе не нашла заметных наездов, использую стандартный зум.")
            except Exception as exc:
                print("референс не разобран:", exc)
                say(chat, "Зум по референсу разобрать не удалось, использую стандартный.")
        inserts = []
        for item in job.get("inserts") or []:
            try:
                inserts.append({**item, "path": download(item, workdir)})
            except Exception as exc:  # одна плохая вставка не должна ронять весь монтаж
                print("вставка не скачалась:", exc)
                say(chat, "Одну вставку скачать не удалось, монтирую без неё. Проверь, что ссылка прямая и открыта всем.")
        result = render(working, segments, workdir, style, profile, inserts, job.get("plates") or [],
                        job.get("captionPosition", "auto"), job.get("captionEdits") or [],
                        job.get("cameraMode", "standard"), job.get("colorFilter", "original"),
                        job.get("plateOpacity"), job.get("captionFont"))
        with open(result, "rb") as f:
            r = requests.post(GATEWAY + "/runner/video", headers={"authorization": f"Bearer {TOKEN}"}, timeout=900,
                              data={"chat_id": str(chat), "caption": f"{job['id']} готов. Стиль: {STYLES[style]['label']}."},
                              files={"video": ("reelbot-result.mp4", f, "video/mp4")})
        if not r.ok:
            raise RuntimeError(f"отправка видео: {r.status_code} {r.text[:200]}")
        send_media_credits(chat, inserts)
        gw("/runner/complete", json={"jobId": job["id"]})
        msg = hook_message(segments)
        if msg:
            say(chat, msg)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main():
    if not GATEWAY or not TOKEN:
        sys.exit("Нужны GATEWAY_URL и TELEGRAM_BOT_TOKEN")
    gw("/runner/activate")
    started = time.time()
    while time.time() - started < TIME_BUDGET:
        job = gw("/runner/next").json().get("job")
        if not job:
            print("задач нет")
            return
        print("взяла задачу", job["id"], "попытка", job.get("attempts"))
        if int(job.get("attempts", 1)) > MAX_ATTEMPTS:
            gw("/runner/fail", json={"jobId": job["id"], "error": "too many attempts",
                                      "userMessage": "Задача не собралась с нескольких попыток. Попробуй ещё раз через /new."})
            continue
        try:
            process(job)
        except UserError as exc:
            gw("/runner/fail", json={"jobId": job["id"], "error": str(exc), "userMessage": str(exc)})
        except Exception as exc:
            print("ошибка монтажа:", exc, file=sys.stderr)
            gw("/runner/fail", json={"jobId": job["id"], "error": str(exc)[:500],
                                      "userMessage": "Что-то пошло не так при монтаже. Если видео больше 20 МБ, пришли ссылку Dropbox или OneDrive."})


if __name__ == "__main__":
    main()
