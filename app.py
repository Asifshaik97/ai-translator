"""
AI Communication Translator — Flask backend
=============================================
Provides REST APIs consumed by the single-page frontend (templates/index.html
+ static/js/main.js) for the four communication modes:

    1. Text  -> Text
    2. Voice -> Text   (speech recognition happens client-side, in the browser)
    3. Text  -> Voice  (server generates an mp3 with gTTS)
    4. Voice -> Voice  (client STT + server translation + server TTS)

Run with:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5000
"""

import os
import io
import uuid
import sqlite3
import datetime

from flask import (
    Flask, render_template, request, jsonify, send_file, g, url_for
)
from deep_translator import GoogleTranslator
from langdetect import detect, DetectorFactory, LangDetectException
from gtts import gTTS
from PIL import Image
import pytesseract
from PyPDF2 import PdfReader
import docx

DetectorFactory.seed = 0  # deterministic langdetect results

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "instance", "translator.db")
AUDIO_DIR = os.path.join(BASE_DIR, "static", "audio")
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB upload limit


# ---------------------------------------------------------------------------
# Supported languages (code -> display name). Covers 100+ languages that are
# supported by both Google Translate (via deep-translator) and gTTS for
# speech output. gTTS supports a slightly smaller subset than Translate; the
# frontend flags voice-unsupported languages instead of hiding them.
# ---------------------------------------------------------------------------
LANGUAGES = {
    "auto": "Auto Detect", "af": "Afrikaans", "sq": "Albanian", "am": "Amharic",
    "ar": "Arabic", "hy": "Armenian", "az": "Azerbaijani", "eu": "Basque",
    "be": "Belarusian", "bn": "Bengali", "bs": "Bosnian", "bg": "Bulgarian",
    "ca": "Catalan", "ceb": "Cebuano", "ny": "Chichewa", "zh-CN": "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)", "co": "Corsican", "hr": "Croatian",
    "cs": "Czech", "da": "Danish", "nl": "Dutch", "en": "English",
    "eo": "Esperanto", "et": "Estonian", "tl": "Filipino", "fi": "Finnish",
    "fr": "French", "fy": "Frisian", "gl": "Galician", "ka": "Georgian",
    "de": "German", "el": "Greek", "gu": "Gujarati", "ht": "Haitian Creole",
    "ha": "Hausa", "haw": "Hawaiian", "iw": "Hebrew", "hi": "Hindi",
    "hmn": "Hmong", "hu": "Hungarian", "is": "Icelandic", "ig": "Igbo",
    "id": "Indonesian", "ga": "Irish", "it": "Italian", "ja": "Japanese",
    "jw": "Javanese", "kn": "Kannada", "kk": "Kazakh", "km": "Khmer",
    "rw": "Kinyarwanda", "ko": "Korean", "ku": "Kurdish", "ky": "Kyrgyz",
    "lo": "Lao", "la": "Latin", "lv": "Latvian", "lt": "Lithuanian",
    "lb": "Luxembourgish", "mk": "Macedonian", "mg": "Malagasy", "ms": "Malay",
    "ml": "Malayalam", "mt": "Maltese", "mi": "Maori", "mr": "Marathi",
    "mn": "Mongolian", "my": "Myanmar (Burmese)", "ne": "Nepali",
    "no": "Norwegian", "or": "Odia", "ps": "Pashto", "fa": "Persian",
    "pl": "Polish", "pt": "Portuguese", "pa": "Punjabi", "ro": "Romanian",
    "ru": "Russian", "sm": "Samoan", "gd": "Scots Gaelic", "sr": "Serbian",
    "st": "Sesotho", "sn": "Shona", "sd": "Sindhi", "si": "Sinhala",
    "sk": "Slovak", "sl": "Slovenian", "so": "Somali", "es": "Spanish",
    "su": "Sundanese", "sw": "Swahili", "sv": "Swedish", "tg": "Tajik",
    "ta": "Tamil", "tt": "Tatar", "te": "Telugu", "th": "Thai",
    "tr": "Turkish", "tk": "Turkmen", "uk": "Ukrainian", "ur": "Urdu",
    "ug": "Uyghur", "uz": "Uzbek", "vi": "Vietnamese", "cy": "Welsh",
    "xh": "Xhosa", "yi": "Yiddish", "yo": "Yoruba", "zu": "Zulu",
}

# Languages gTTS can speak (BCP-47-ish codes gTTS accepts). Anything not in
# here still translates fine, it just can't be spoken aloud.
GTTS_SUPPORTED = {
    "af", "ar", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en",
    "eo", "es", "et", "fi", "fr", "gu", "hi", "hr", "hu", "hy", "id", "is",
    "it", "iw", "ja", "jw", "km", "kn", "ko", "la", "lt", "lv", "mk", "ml",
    "mr", "ms", "my", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "si",
    "sk", "sq", "sr", "su", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk",
    "ur", "vi", "zh-CN", "zh-TW",
}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            source_lang TEXT,
            target_lang TEXT,
            source_text TEXT,
            translated_text TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_lang TEXT,
            target_lang TEXT,
            source_text TEXT,
            translated_text TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


init_db()


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------
def detect_language(text: str) -> str:
    """Best-effort language detection. Falls back to 'en' on failure."""
    try:
        code = detect(text)
        # langdetect uses zh-cn / zh-tw with lowercase; normalise a couple of
        # common mismatches against our LANGUAGES table.
        mapping = {"zh-cn": "zh-CN", "zh-tw": "zh-TW", "he": "iw"}
        return mapping.get(code, code)
    except LangDetectException:
        return "en"


def do_translate(text: str, source: str, target: str) -> str:
    src = "auto" if source in (None, "", "auto") else source
    translator = GoogleTranslator(source=src, target=target)
    # deep_translator has a ~5000 char limit per call; chunk long text.
    chunks = [text[i:i + 4500] for i in range(0, len(text), 4500)] or [""]
    return " ".join(translator.translate(c) for c in chunks)


def save_history(mode, source_lang, target_lang, source_text, translated_text):
    db = get_db()
    db.execute(
        "INSERT INTO history (mode, source_lang, target_lang, source_text, "
        "translated_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (mode, source_lang, target_lang, source_text, translated_text,
         datetime.datetime.utcnow().isoformat()),
    )
    db.commit()


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API: languages
# ---------------------------------------------------------------------------
@app.route("/api/languages")
def api_languages():
    return jsonify({
        "languages": LANGUAGES,
        "voice_supported": sorted(GTTS_SUPPORTED),
    })


# ---------------------------------------------------------------------------
# API: detect language only
# ---------------------------------------------------------------------------
@app.route("/api/detect", methods=["POST"])
def api_detect():
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "No text provided"}), 400
    code = detect_language(text)
    return jsonify({"lang": code, "lang_name": LANGUAGES.get(code, code)})


# ---------------------------------------------------------------------------
# API: translate (used by all 4 modes)
# ---------------------------------------------------------------------------
@app.route("/api/translate", methods=["POST"])
def api_translate():
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    target = data.get("target", "en")
    source = data.get("source", "auto")
    mode = data.get("mode", "text-to-text")
    grammar_fix = bool(data.get("grammar_correction", False))

    if not text:
        return jsonify({"error": "No text provided"}), 400

    detected = source if source not in (None, "", "auto") else detect_language(text)

    try:
        translated = do_translate(text, source, target)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Translation failed: {exc}"}), 500

    corrected_source = None
    if grammar_fix:
        # Lightweight "grammar correction": round-trip translate the source
        # text through English and back to its own language. This smooths
        # over many grammatical issues without needing a dedicated model.
        try:
            if detected != "en":
                bounce = do_translate(text, detected, "en")
                corrected_source = do_translate(bounce, "en", detected)
            else:
                corrected_source = text
        except Exception:  # noqa: BLE001
            corrected_source = None

    save_history(mode, detected, target, text, translated)

    return jsonify({
        "original_text": text,
        "translated_text": translated,
        "detected_lang": detected,
        "detected_lang_name": LANGUAGES.get(detected, detected),
        "target_lang": target,
        "target_lang_name": LANGUAGES.get(target, target),
        "corrected_source": corrected_source,
        "voice_available": target in GTTS_SUPPORTED,
    })


# ---------------------------------------------------------------------------
# API: text-to-speech
# ---------------------------------------------------------------------------
@app.route("/api/tts", methods=["POST"])
def api_tts():
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    lang = data.get("lang", "en")

    if not text:
        return jsonify({"error": "No text provided"}), 400

    tts_lang = lang if lang in GTTS_SUPPORTED else "en"

    try:
        filename = f"{uuid.uuid4().hex}.mp3"
        filepath = os.path.join(AUDIO_DIR, filename)
        gTTS(text=text, lang=tts_lang).save(filepath)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Speech synthesis failed: {exc}"}), 500

    return jsonify({
        "audio_url": url_for("static", filename=f"audio/{filename}"),
        "used_lang": tts_lang,
    })


# ---------------------------------------------------------------------------
# API: OCR image translation
# ---------------------------------------------------------------------------
@app.route("/api/ocr", methods=["POST"])
def api_ocr():
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    file = request.files["image"]
    target = request.form.get("target", "en")

    try:
        image = Image.open(file.stream).convert("RGB")
        extracted = pytesseract.image_to_string(image).strip()
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"OCR failed (is Tesseract installed?): {exc}"}), 500

    if not extracted:
        return jsonify({"error": "No text detected in the image"}), 400

    detected = detect_language(extracted)
    try:
        translated = do_translate(extracted, detected, target)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Translation failed: {exc}"}), 500

    save_history("ocr", detected, target, extracted, translated)

    return jsonify({
        "extracted_text": extracted,
        "translated_text": translated,
        "detected_lang": detected,
        "detected_lang_name": LANGUAGES.get(detected, detected),
    })


# ---------------------------------------------------------------------------
# API: document translation (.txt, .docx, .pdf)
# ---------------------------------------------------------------------------
def extract_text_from_file(file_storage) -> str:
    filename = file_storage.filename.lower()

    if filename.endswith(".txt"):
        return file_storage.read().decode("utf-8", errors="ignore")

    if filename.endswith(".docx"):
        document = docx.Document(file_storage)
        return "\n".join(p.text for p in document.paragraphs)

    if filename.endswith(".pdf"):
        reader = PdfReader(file_storage)
        return "\n".join((page.extract_text() or "") for page in reader.pages)

    raise ValueError("Unsupported file type. Use .txt, .docx, or .pdf")


@app.route("/api/file-translate", methods=["POST"])
def api_file_translate():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    target = request.form.get("target", "en")

    try:
        text = extract_text_from_file(file).strip()
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400

    if not text:
        return jsonify({"error": "No text could be extracted from the file"}), 400

    detected = detect_language(text)
    try:
        translated = do_translate(text, detected, target)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Translation failed: {exc}"}), 500

    out_name = f"{uuid.uuid4().hex}.txt"
    out_path = os.path.join(UPLOAD_DIR, out_name)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(translated)

    save_history("file", detected, target, text[:500], translated[:500])

    return jsonify({
        "original_text": text,
        "translated_text": translated,
        "detected_lang": detected,
        "detected_lang_name": LANGUAGES.get(detected, detected),
        "download_url": url_for("static", filename=f"uploads/{out_name}"),
    })


# ---------------------------------------------------------------------------
# API: history
# ---------------------------------------------------------------------------
@app.route("/api/history", methods=["GET"])
def api_history_list():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM history ORDER BY id DESC LIMIT 100"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/history/<int:item_id>", methods=["DELETE"])
def api_history_delete(item_id):
    db = get_db()
    db.execute("DELETE FROM history WHERE id = ?", (item_id,))
    db.commit()
    return jsonify({"status": "deleted"})


@app.route("/api/history", methods=["DELETE"])
def api_history_clear():
    db = get_db()
    db.execute("DELETE FROM history")
    db.commit()
    return jsonify({"status": "cleared"})


# ---------------------------------------------------------------------------
# API: favorites
# ---------------------------------------------------------------------------
@app.route("/api/favorites", methods=["GET"])
def api_favorites_list():
    db = get_db()
    rows = db.execute("SELECT * FROM favorites ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/favorites", methods=["POST"])
def api_favorites_add():
    data = request.get_json(force=True)
    db = get_db()
    db.execute(
        "INSERT INTO favorites (source_lang, target_lang, source_text, "
        "translated_text, created_at) VALUES (?, ?, ?, ?, ?)",
        (data.get("source_lang"), data.get("target_lang"),
         data.get("source_text"), data.get("translated_text"),
         datetime.datetime.utcnow().isoformat()),
    )
    db.commit()
    return jsonify({"status": "added"})


@app.route("/api/favorites/<int:item_id>", methods=["DELETE"])
def api_favorites_delete(item_id):
    db = get_db()
    db.execute("DELETE FROM favorites WHERE id = ?", (item_id,))
    db.commit()
    return jsonify({"status": "deleted"})


# ---------------------------------------------------------------------------
# OPTIONAL: server-side Whisper STT endpoint.
# Uncomment this (and the openai-whisper line in requirements.txt) if you
# want speech recognition to run on the server instead of relying on the
# browser's Web Speech API. Requires ffmpeg installed on the host machine.
# ---------------------------------------------------------------------------
# import whisper
# _whisper_model = None
#
# def get_whisper_model():
#     global _whisper_model
#     if _whisper_model is None:
#         _whisper_model = whisper.load_model("base")
#     return _whisper_model
#
# @app.route("/api/stt", methods=["POST"])
# def api_stt():
#     if "audio" not in request.files:
#         return jsonify({"error": "No audio uploaded"}), 400
#     file = request.files["audio"]
#     temp_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}.webm")
#     file.save(temp_path)
#     try:
#         result = get_whisper_model().transcribe(temp_path)
#         return jsonify({
#             "text": result["text"].strip(),
#             "detected_lang": result.get("language", "en"),
#         })
#     finally:
#         os.remove(temp_path)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
