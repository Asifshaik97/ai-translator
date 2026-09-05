# AI Communication Translator

A Flask + Bootstrap 5 web app with four communication modes (Text→Text,
Voice→Text, Text→Voice, Voice→Voice), plus OCR image translation and
document translation, and light/dark mode.

## 1. Setup

```bash
cd ai-translator
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:5000** in **Chrome or Edge** (Web Speech API for the
voice modes only works in Chromium-based browsers, and requires HTTPS or
`localhost`).

## 2. How it works

| Layer | Tech | Notes |
|---|---|---|
| Translation | `deep-translator` (Google Translate) | Auto-chunks long text |
| Language detection | `langdetect` | Server-side, deterministic seed |
| Speech-to-Text | Browser **Web Speech API** | Zero server load, real-time. See "Optional Whisper" below for a server-side alternative |
| Text-to-Speech | `gTTS` | Generates downloadable/playable mp3s server-side |
| OCR | `rapidocr` (ONNX Runtime) + Pillow | Pure pip install — no system binary required |
| Document translation | `PyPDF2`, `python-docx` | `.pdf`, `.docx`, `.txt` supported |

### OCR: no system dependency needed
OCR runs on [RapidOCR](https://github.com/RapidAI/RapidOCR), a pure-Python
library backed by ONNX Runtime. Unlike Tesseract, it needs no separate OS-level
install — `pip install -r requirements.txt` is enough on Windows, macOS,
Linux, and on Render's native (non-Docker) environment. The first OCR call
downloads and caches its small model files automatically.

### Optional: server-side Whisper STT
The default build uses the browser's built-in speech recognition, which
needs no extra install and works well for a demo/academic project. If you'd
rather run OpenAI Whisper on the server (useful for browsers without Web
Speech API support, e.g. Firefox), uncomment the Whisper block at the bottom
of `app.py` and the `openai-whisper` / `ffmpeg-python` lines in
`requirements.txt`, then install `ffmpeg` on your system.

## 3. Features implemented

- 4 core modes (Text↔Text/Voice combinations) launched from the home screen
- Automatic source-language detection on every translation
- Searchable modal language picker (100+ languages), swap source/target
- Copy, clear, and download translated text
- Server-generated natural TTS audio with replay + mp3 download
- Conversation mode for Voice→Voice (auto-swaps languages after each turn and re-opens the mic)
- Lightweight AI grammar correction (round-trip translation smoothing), toggleable
- OCR image translation (upload or camera capture on mobile)
- Document translation for `.txt`, `.docx`, `.pdf`
- Light/dark theme toggle (persisted in localStorage)
- Fully responsive Bootstrap 5 layout, mobile-friendly mic and camera capture

## 4. Project structure

```
ai-translator/
├── app.py                 # Flask backend & all API routes
├── requirements.txt
├── instance/
│   └── translator.db      # created automatically
├── templates/
│   └── index.html
└── static/
    ├── css/style.css
    ├── js/main.js
    ├── audio/              # generated TTS mp3 files
    └── uploads/            # translated document downloads
```

## 5. Future enhancements (as scoped)

- Swap SQLite for Firebase/Supabase for multi-user cloud sync
- Offline translation via a bundled local model
- Pronunciation scoring for language-learning use cases
- Live camera OCR overlay (continuous frame capture instead of single photo)
