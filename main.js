/* =========================================================================
   AI Communication Translator — frontend logic
   Handles: mode switching, language picking, translation API calls,
   browser speech recognition (STT) & playback, server TTS, OCR / file
   translation, history, favorites, theme toggle.
   ========================================================================= */

const state = {
  mode: null,                 // 'text-text' | 'voice-text' | 'text-voice' | 'voice-voice' | 'ocr' | 'file'
  languages: {},
  voiceSupported: new Set(),
  sourceLang: "auto",
  targetLang: "en",
  activePicker: null,         // 'source' | 'target'
  lastTranslation: null,
  recognizing: false,
  recognition: null,
  conversationMode: false,
};

const el = (id) => document.getElementById(id);
const toast = (msg) => {
  el("appToastBody").textContent = msg;
  new bootstrap.Toast(el("appToast")).show();
};

/* ---------------------------------------------------------------------- */
/* Theme                                                                   */
/* ---------------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
}
function updateThemeIcon(theme) {
  el("themeToggle").querySelector("i").className =
    theme === "dark" ? "bi bi-sun" : "bi bi-moon-stars";
}
el("themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon(next);
});

/* ---------------------------------------------------------------------- */
/* Load languages                                                          */
/* ---------------------------------------------------------------------- */
async function loadLanguages() {
  const res = await fetch("/api/languages");
  const data = await res.json();
  state.languages = data.languages;
  state.voiceSupported = new Set(data.voice_supported);
  el("sourceLangLabel").textContent = state.languages["auto"];
  el("targetLangLabel").textContent = state.languages["en"];
}

/* ---------------------------------------------------------------------- */
/* Mode selection / workspace view                                         */
/* ---------------------------------------------------------------------- */
const MODE_META = {
  "text-text": { title: "Text → Text", input: "text" },
  "voice-text": { title: "Voice → Text", input: "voice" },
  "text-voice": { title: "Text → Voice", input: "text", voiceOut: true },
  "voice-voice": { title: "Voice → Voice", input: "voice", voiceOut: true, conversation: true },
  "ocr": { title: "Image Translation (OCR)", input: "ocr" },
  "file": { title: "Document Translation", input: "file" },
};

document.querySelectorAll(".mode-card").forEach((btn) => {
  btn.addEventListener("click", () => enterMode(btn.dataset.mode));
});
el("brandHome").addEventListener("click", (e) => { e.preventDefault(); goHome(); });
el("backHome").addEventListener("click", goHome);

function goHome() {
  el("homeView").classList.remove("d-none");
  el("workspaceView").classList.add("d-none");
  stopRecognition();
}

function enterMode(mode) {
  state.mode = mode;
  const meta = MODE_META[mode];
  el("homeView").classList.add("d-none");
  el("workspaceView").classList.remove("d-none");
  document.querySelector(".workspace-title").textContent = meta.title;

  // Reset panels
  ["textInputArea", "voiceInputArea", "ocrInputArea", "fileInputArea"].forEach(
    (id) => el(id).classList.add("d-none")
  );
  el("audioControls").classList.add("d-none");
  el("outputText").textContent = "Your translation will appear here...";
  el("correctedSourceWrap").style.display = "none";
  el("sourceTextVoice").value = "";
  el("sourceText").value = "";

  if (meta.input === "text") el("textInputArea").classList.remove("d-none");
  if (meta.input === "voice") {
    el("voiceInputArea").classList.remove("d-none");
    el("micStatus").textContent = "Tap the mic and start speaking";
  }
  if (meta.input === "ocr") el("ocrInputArea").classList.remove("d-none");
  if (meta.input === "file") el("fileInputArea").classList.remove("d-none");

  el("conversationSwitchWrap").classList.toggle("d-none", !meta.conversation);
  el("conversationSwitch").checked = false;
  state.conversationMode = false;

  el("grammarSwitchWrap").classList.toggle("d-none", meta.input === "ocr" || meta.input === "file");
}

/* ---------------------------------------------------------------------- */
/* Language picker modal                                                   */
/* ---------------------------------------------------------------------- */
const langModal = new bootstrap.Modal(el("langModal"));

document.querySelectorAll("[data-picker]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activePicker = btn.dataset.picker;
    renderLangList("");
    el("langSearch").value = "";
    langModal.show();
    setTimeout(() => el("langSearch").focus(), 300);
  });
});

el("langSearch").addEventListener("input", (e) => renderLangList(e.target.value));

function renderLangList(query) {
  const list = el("langList");
  list.innerHTML = "";
  const q = query.trim().toLowerCase();
  const isSource = state.activePicker === "source";
  const currentVal = isSource ? state.sourceLang : state.targetLang;

  const entries = Object.entries(state.languages).filter(([code, name]) => {
    if (!isSource && code === "auto") return false; // target can't be "auto"
    return name.toLowerCase().includes(q) || code.toLowerCase().includes(q);
  });

  entries.forEach(([code, name]) => {
    const item = document.createElement("div");
    item.className = "lang-item d-flex justify-content-between align-items-center" +
      (code === currentVal ? " active" : "");
    const noVoice = !state.voiceSupported.has(code) && code !== "auto";
    item.innerHTML = `<span>${name}</span>` +
      (noVoice ? `<span class="no-voice">text only</span>` : "");
    item.addEventListener("click", () => {
      if (isSource) {
        state.sourceLang = code;
        el("sourceLangLabel").textContent = name;
      } else {
        state.targetLang = code;
        el("targetLangLabel").textContent = name;
      }
      langModal.hide();
    });
    list.appendChild(item);
  });
}

el("swapLangs").addEventListener("click", () => {
  if (state.sourceLang === "auto") {
    toast("Detect the language first, then you can swap.");
    return;
  }
  [state.sourceLang, state.targetLang] = [state.targetLang, state.sourceLang];
  el("sourceLangLabel").textContent = state.languages[state.sourceLang];
  el("targetLangLabel").textContent = state.languages[state.targetLang];
});

/* ---------------------------------------------------------------------- */
/* Translate (text-based modes)                                            */
/* ---------------------------------------------------------------------- */
el("clearInput").addEventListener("click", () => {
  el("sourceText").value = "";
  el("outputText").textContent = "Your translation will appear here...";
  el("audioControls").classList.add("d-none");
});

el("translateBtn").addEventListener("click", () => {
  const text = el("sourceText").value.trim();
  if (!text) { toast("Please type some text first."); return; }
  runTranslate(text);
});

async function runTranslate(text) {
  el("outputText").textContent = "Translating...";
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source: state.sourceLang,
        target: state.targetLang,
        mode: state.mode,
        grammar_correction: el("grammarSwitch").checked,
      }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error); el("outputText").textContent = "—"; return; }

    state.lastTranslation = data;
    el("outputText").textContent = data.translated_text;
    el("sourceLangLabel").textContent = data.detected_lang_name;
    state.sourceLang = data.detected_lang; // lock in detected language for swap/history

    if (data.corrected_source && data.corrected_source !== data.original_text) {
      el("correctedSourceText").textContent = data.corrected_source;
      el("correctedSourceWrap").style.display = "block";
    } else {
      el("correctedSourceWrap").style.display = "none";
    }

    const meta = MODE_META[state.mode];
    if (meta && meta.voiceOut) {
      await speakTranslation(data.translated_text, state.targetLang);
      if (state.conversationMode) scheduleConversationTurn();
    }
  } catch (err) {
    el("outputText").textContent = "—";
    toast("Something went wrong. Please try again.");
  }
}

/* ---------------------------------------------------------------------- */
/* Text-to-speech (server side, gTTS)                                      */
/* ---------------------------------------------------------------------- */
async function speakTranslation(text, lang) {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error); return; }

    const player = el("audioPlayer");
    player.src = data.audio_url;
    el("audioControls").classList.remove("d-none");
    el("downloadAudioBtn").href = data.audio_url;
    el("downloadAudioBtn").setAttribute("download", "translation.mp3");
    await player.play().catch(() => {});
  } catch (err) {
    toast("Could not generate speech audio.");
  }
}

/* ---------------------------------------------------------------------- */
/* Speech recognition (browser Web Speech API)                             */
/* ---------------------------------------------------------------------- */
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

function buildRecognition() {
  if (!SpeechRecognitionAPI) return null;
  const rec = new SpeechRecognitionAPI();
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  // Hint the recognizer with the currently selected source language, or
  // fall back to the browser's locale when "auto" is selected — actual
  // language detection of the *translated* text still happens server-side.
  rec.lang = state.sourceLang !== "auto" ? bcp47(state.sourceLang) : navigator.language || "en-US";
  return rec;
}

function bcp47(code) {
  const map = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "iw": "he-IL", "en": "en-US",
    "fr": "fr-FR", "de": "de-DE", "es": "es-ES", "pt": "pt-PT", "ar": "ar-SA",
    "hi": "hi-IN", "ja": "ja-JP", "ko": "ko-KR", "ru": "ru-RU", "it": "it-IT" };
  return map[code] || code;
}

el("micBtn").addEventListener("click", () => {
  if (!SpeechRecognitionAPI) {
    toast("Speech recognition isn't supported in this browser. Try Chrome or Edge.");
    return;
  }
  if (state.recognizing) { stopRecognition(); return; }
  startRecognition();
});

el("conversationSwitch").addEventListener("change", (e) => {
  state.conversationMode = e.target.checked;
});

function startRecognition() {
  const rec = buildRecognition();
  if (!rec) return;
  state.recognition = rec;
  state.recognizing = true;
  el("micBtn").classList.add("listening");
  el("micStatus").textContent = "Listening...";

  rec.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    el("sourceTextVoice").value = transcript;
  };

  rec.onerror = () => {
    el("micStatus").textContent = "Didn't catch that — tap to try again.";
  };

  rec.onend = () => {
    state.recognizing = false;
    el("micBtn").classList.remove("listening");
    const finalText = el("sourceTextVoice").value.trim();
    if (finalText) {
      el("micStatus").textContent = "Tap the mic and start speaking";
      runTranslate(finalText);
    } else {
      el("micStatus").textContent = "Tap the mic and start speaking";
    }
  };

  rec.start();
}

function stopRecognition() {
  if (state.recognition && state.recognizing) {
    state.recognition.stop();
  }
  state.recognizing = false;
  el("micBtn").classList.remove("listening");
}

function scheduleConversationTurn() {
  // Swap languages and re-open the mic automatically for the next speaker.
  setTimeout(() => {
    [state.sourceLang, state.targetLang] = [state.targetLang, state.sourceLang];
    el("sourceLangLabel").textContent = state.languages[state.sourceLang];
    el("targetLangLabel").textContent = state.languages[state.targetLang];
    el("sourceTextVoice").value = "";
    if (state.conversationMode) startRecognition();
  }, 800);
}

/* ---------------------------------------------------------------------- */
/* OCR                                                                      */
/* ---------------------------------------------------------------------- */
el("ocrTranslateBtn").addEventListener("click", async () => {
  const fileInput = el("ocrFile");
  if (!fileInput.files.length) { toast("Choose an image first."); return; }
  const formData = new FormData();
  formData.append("image", fileInput.files[0]);
  formData.append("target", state.targetLang);

  el("outputText").textContent = "Reading image...";
  try {
    const res = await fetch("/api/ocr", { method: "POST", body: formData });
    const data = await res.json();
    if (data.error) { toast(data.error); el("outputText").textContent = "—"; return; }
    el("sourceLangLabel").textContent = data.detected_lang_name;
    state.sourceLang = data.detected_lang;
    el("outputText").textContent = data.translated_text;
    state.lastTranslation = data;
  } catch (err) {
    toast("OCR failed. Make sure Tesseract is installed on the server.");
  }
});

/* ---------------------------------------------------------------------- */
/* File translation                                                        */
/* ---------------------------------------------------------------------- */
let lastFileDownloadUrl = null;

el("fileTranslateBtn").addEventListener("click", async () => {
  const fileInput = el("docFile");
  if (!fileInput.files.length) { toast("Choose a .txt, .docx, or .pdf file."); return; }
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("target", state.targetLang);

  el("outputText").textContent = "Extracting & translating...";
  try {
    const res = await fetch("/api/file-translate", { method: "POST", body: formData });
    const data = await res.json();
    if (data.error) { toast(data.error); el("outputText").textContent = "—"; return; }
    el("sourceLangLabel").textContent = data.detected_lang_name;
    state.sourceLang = data.detected_lang;
    el("outputText").textContent = data.translated_text;
    lastFileDownloadUrl = data.download_url;
    state.lastTranslation = data;
  } catch (err) {
    toast("File translation failed.");
  }
});

/* ---------------------------------------------------------------------- */
/* Output actions: copy / download text / favorite                         */
/* ---------------------------------------------------------------------- */
el("copyBtn").addEventListener("click", async () => {
  const text = el("outputText").textContent;
  if (!text || text === "Your translation will appear here...") return;
  await navigator.clipboard.writeText(text);
  toast("Copied to clipboard.");
});

el("downloadTextBtn").addEventListener("click", () => {
  const text = el("outputText").textContent;
  if (!text || text === "Your translation will appear here...") return;
  const blob = new Blob([text], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "translation.txt";
  link.click();
});

el("favoriteBtn").addEventListener("click", async () => {
  if (!state.lastTranslation) { toast("Translate something first."); return; }
  const t = state.lastTranslation;
  await fetch("/api/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_lang: state.sourceLang,
      target_lang: state.targetLang,
      source_text: t.original_text || t.extracted_text || "",
      translated_text: t.translated_text,
    }),
  });
  toast("Saved to favorites.");
});

/* ---------------------------------------------------------------------- */
/* History & Favorites panels                                              */
/* ---------------------------------------------------------------------- */
const historyPanel = new bootstrap.Offcanvas(el("historyPanel"));
const favoritesPanel = new bootstrap.Offcanvas(el("favoritesPanel"));

el("historyBtn").addEventListener("click", async () => {
  await renderHistory();
  historyPanel.show();
});
el("favoritesBtn").addEventListener("click", async () => {
  await renderFavorites();
  favoritesPanel.show();
});

async function renderHistory() {
  const res = await fetch("/api/history");
  const items = await res.json();
  const container = el("historyList");
  container.innerHTML = items.length ? "" : `<p class="text-muted">No history yet.</p>`;
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div class="meta">${item.mode} · ${item.source_lang} → ${item.target_lang}</div>
      <div><strong>${escapeHtml(item.source_text || "").slice(0, 120)}</strong></div>
      <div>${escapeHtml(item.translated_text || "").slice(0, 120)}</div>
      <button class="btn btn-sm btn-link p-0 mt-1 text-danger" data-id="${item.id}">Delete</button>
    `;
    div.querySelector("button").addEventListener("click", async () => {
      await fetch(`/api/history/${item.id}`, { method: "DELETE" });
      renderHistory();
    });
    container.appendChild(div);
  });
}

el("clearHistoryBtn").addEventListener("click", async () => {
  await fetch("/api/history", { method: "DELETE" });
  renderHistory();
});

async function renderFavorites() {
  const res = await fetch("/api/favorites");
  const items = await res.json();
  const container = el("favoritesList");
  container.innerHTML = items.length ? "" : `<p class="text-muted">No favorites yet.</p>`;
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "fav-item";
    div.innerHTML = `
      <div class="meta">${item.source_lang} → ${item.target_lang}</div>
      <div><strong>${escapeHtml(item.source_text || "").slice(0, 120)}</strong></div>
      <div>${escapeHtml(item.translated_text || "").slice(0, 120)}</div>
      <button class="btn btn-sm btn-link p-0 mt-1 text-danger" data-id="${item.id}">Remove</button>
    `;
    div.querySelector("button").addEventListener("click", async () => {
      await fetch(`/api/favorites/${item.id}`, { method: "DELETE" });
      renderFavorites();
    });
    container.appendChild(div);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ---------------------------------------------------------------------- */
/* Init                                                                     */
/* ---------------------------------------------------------------------- */
initTheme();
loadLanguages();
