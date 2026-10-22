/* ==========================================================================
   CareOrbit AI - Premium Voice Mode
   Full-screen, hands-free voice conversation layered on top of the existing
   Copilot. Load AFTER app.js:  <script src="voice.js"></script>
   Needs: voice.css, and the small hooks added to app.js
   (careorbit:reply event, CareOrbit.sendMessage, CareOrbit.isBusy).
   ========================================================================== */
   (function () {
    "use strict";
  
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const synth = window.speechSynthesis || null;
  
    const LANGS = [
      { code: "en-IN", label: "English" },
      { code: "hi-IN", label: "हिन्दी" },
      { code: "te-IN", label: "తెలుగు" }
    ];
  
    const CHIPS = [
      "What needs my attention right now?",
      "When does my warranty end?",
      "Show my service history",
      "Book a service appointment"
    ];
  
    const YES = /\b(yes|yeah|yep|approve|approved|confirm|confirmed|go ahead|do it|ok|okay|sure|proceed)\b|हाँ|हां|ठीक है|అవును|సరే/i;
    const NO = /\b(no|nope|cancel|stop|don't|do not|never mind|reject)\b|नहीं|रद्द|కాదు|వద్దు/i;
    const CLOSE = /^\s*(close|exit|goodbye|bye|that's all|stop listening)\b/i;
  
    function load(key, fallback) {
      try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
    }
    function save(key, value) {
      try { localStorage.setItem(key, value); } catch (e) {}
    }
  
    const V = {
      active: false,
      state: "idle",
      lang: load("careorbit_voice_lang", "en-IN"),
      muted: load("careorbit_voice_muted", "0") === "1",
      rec: null,
      finalText: "",
      interim: "",
      silence: 0,
      fatal: false,
      speakToken: 0,
      timers: []
    };
    window.CareOrbitVoice = V;
  
    // -------------------------------------------------------------------------
    // Build UI
    // -------------------------------------------------------------------------
    const MIC_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    const CLOSE_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SPEAKER_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    const MUTED_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
  
    const root = document.createElement("div");
    root.innerHTML =
      '<button type="button" id="cv-fab" aria-label="Talk to CareOrbit">' + MIC_SVG + "<span>Talk to CareOrbit</span></button>" +
      '<section id="cv-overlay" hidden role="dialog" aria-modal="true" aria-label="CareOrbit voice mode" data-state="idle" data-approval="0">' +
      '  <div class="cv-top">' +
      '    <div class="cv-brand"><span class="cv-dot"></span>CareOrbit Voice</div>' +
      '    <div class="cv-top-actions">' +
      '      <div class="cv-langs" id="cv-langs" role="group" aria-label="Voice language"></div>' +
      '      <button type="button" id="cv-mute" class="cv-icon" aria-label="Mute spoken replies"></button>' +
      '      <button type="button" id="cv-close" class="cv-icon" aria-label="Close voice mode">' + CLOSE_SVG + "</button>" +
      "    </div>" +
      "  </div>" +
      '  <div class="cv-stage">' +
      '    <button type="button" id="cv-orb" class="cv-orb" aria-label="Tap to talk, or tap to interrupt">' +
      '      <span class="cv-ring cv-r1"></span><span class="cv-ring cv-r2"></span><span class="cv-ring cv-r3"></span>' +
      '      <span class="cv-core">' + MIC_SVG + "</span>" +
      "    </button>" +
      '    <p id="cv-status" class="cv-status" aria-live="polite">Starting…</p>' +
      "  </div>" +
      '  <div class="cv-convo">' +
      '    <p id="cv-you" class="cv-you"></p>' +
      '    <p id="cv-reply" class="cv-reply" aria-live="polite"></p>' +
      "  </div>" +
      '  <div id="cv-approval" class="cv-approval" hidden>' +
      '    <div id="cv-approval-title" class="cv-approval-title"></div>' +
      '    <ul id="cv-approval-list" class="cv-approval-list"></ul>' +
      '    <div class="cv-approval-actions">' +
      '      <button type="button" id="cv-approve" class="cv-btn ok">Approve</button>' +
      '      <button type="button" id="cv-cancel" class="cv-btn no">Cancel</button>' +
      "    </div>" +
      "  </div>" +
      '  <div class="cv-chips" id="cv-chips"></div>' +
      '  <form id="cv-form" class="cv-form" autocomplete="off">' +
      '    <input id="cv-input" type="text" placeholder="Or type your question…" aria-label="Type your question">' +
      '    <button type="submit">Send</button>' +
      "  </form>" +
      "</section>";
    document.body.appendChild(root);
  
    const $ = (id) => document.getElementById(id);
    const fab = $("cv-fab");
    const overlay = $("cv-overlay");
    const orb = $("cv-orb");
    const statusEl = $("cv-status");
    const youEl = $("cv-you");
    const replyEl = $("cv-reply");
    const approvalBox = $("cv-approval");
    const approvalTitle = $("cv-approval-title");
    const approvalList = $("cv-approval-list");
    const muteBtn = $("cv-mute");
    const langBox = $("cv-langs");
    const chipsBox = $("cv-chips");
    const form = $("cv-form");
    const input = $("cv-input");
  
    LANGS.forEach((l) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cv-lang" + (l.code === V.lang ? " active" : "");
      b.dataset.code = l.code;
      b.textContent = l.label;
      b.onclick = () => setLang(l.code);
      langBox.appendChild(b);
    });
  
    CHIPS.forEach((text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cv-chip";
      b.textContent = text;
      b.onclick = () => sendTyped(text);
      chipsBox.appendChild(b);
    });
  
    function renderMute() {
      muteBtn.innerHTML = V.muted ? MUTED_SVG : SPEAKER_SVG;
      muteBtn.setAttribute("aria-pressed", V.muted ? "true" : "false");
      muteBtn.title = V.muted ? "Spoken replies are off" : "Spoken replies are on";
    }
    renderMute();
  
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function later(fn, ms) {
      const id = setTimeout(fn, ms);
      V.timers.push(id);
      return id;
    }
    function clearTimers() {
      V.timers.forEach(clearTimeout);
      V.timers = [];
    }
  
    function setState(state, label) {
      V.state = state;
      overlay.dataset.state = state;
      fab.classList.toggle("is-live", V.active);
      if (label) statusEl.textContent = label;
    }
  
    function setLang(code) {
      V.lang = code;
      save("careorbit_voice_lang", code);
      langBox.querySelectorAll(".cv-lang").forEach((b) => b.classList.toggle("active", b.dataset.code === code));
      const old = document.getElementById("voice-lang-select");
      if (old) old.value = code;
      if (V.active && V.state === "listening") {
        killRecognizer();
        startListening();
      }
    }
  
    // The latest approval card in the chat that is still waiting for an answer.
    function pendingSlip() {
      const btns = document.querySelectorAll(".approval-card-slip .slip-btn.approve");
      const last = btns[btns.length - 1];
      return last && !last.disabled ? last : null;
    }
  
    function showApproval() {
      const btn = pendingSlip();
      approvalBox.hidden = !btn;
      overlay.dataset.approval = btn ? "1" : "0";
      if (!btn) return;
      const card = btn.closest(".approval-card-slip");
      const sub = card.querySelector(".slip-sub");
      approvalTitle.textContent = sub ? sub.textContent.trim() : "Approval required";
      approvalList.replaceChildren();
      card.querySelectorAll(".slip-details-list dt").forEach((dt, i) => {
        if (i >= 5) return;
        const dd = dt.nextElementSibling;
        const li = document.createElement("li");
        li.textContent = dt.textContent.trim() + " " + (dd ? dd.textContent.trim() : "");
        approvalList.appendChild(li);
      });
    }
  
    function chooseApproval(yes) {
      const btn = pendingSlip();
      if (!btn) return;
      const card = btn.closest(".approval-card-slip");
      const target = card.querySelector(yes ? ".slip-btn.approve" : ".slip-btn.cancel");
      killRecognizer();
      V.speakToken++;
      if (synth) synth.cancel();
      approvalBox.hidden = true;
      overlay.dataset.approval = "0";
      setState("thinking", yes ? "Approved. Working on it…" : "Cancelled. One moment…");
      startThinkTimers();
      if (target) target.click();
    }
  
    // -------------------------------------------------------------------------
    // Listening
    // -------------------------------------------------------------------------
    function killRecognizer() {
      if (V.rec) {
        V.rec._dead = true;
        try { V.rec.abort(); } catch (e) {}
        V.rec = null;
      }
    }
  
    function startListening() {
      if (!V.active) return;
      if (!SR) {
        setState("idle", "Voice input isn't supported in this browser. Type below, or use Chrome or Edge.");
        return;
      }
      if (synth) synth.cancel();
      V.speakToken++;
      killRecognizer();
  
      const rec = new SR();
      rec.lang = V.lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      V.rec = rec;
      V.finalText = "";
      V.interim = "";
  
      rec.onstart = () => {
        if (rec._dead) return;
        setState("listening", pendingSlip() ? "Say “approve” or “cancel”" : "Listening…");
      };
  
      rec.onresult = (e) => {
        if (rec._dead) return;
        let fin = "";
        let tmp = "";
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) fin += t;
          else tmp += t;
        }
        V.finalText = fin;
        V.interim = tmp;
        youEl.textContent = (fin + " " + tmp).trim();
        youEl.classList.add("live");
      };
  
      rec.onerror = (e) => {
        if (rec._dead) return;
        const err = e.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          V.fatal = true;
          setState("error", "Microphone is blocked. Allow it in the address bar, then tap the orb.");
        } else if (err === "audio-capture") {
          V.fatal = true;
          setState("error", "No microphone found. Check your device, then tap the orb.");
        } else if (err === "network") {
          V.fatal = true;
          setState("error", "Speech service unreachable. Check your internet, then tap the orb.");
        }
        // "no-speech" and "aborted" are handled in onend.
      };
  
      rec.onend = () => {
        if (V.rec === rec) V.rec = null;
        if (rec._dead || !V.active || V.fatal) return;
        const text = (V.finalText || V.interim).trim();
        if (text) {
          handleUtterance(text);
          return;
        }
        V.silence++;
        if (V.silence >= 3) {
          setState("idle", "Tap the orb when you're ready");
          return;
        }
        later(startListening, 250);
      };
  
      try {
        rec.start();
      } catch (e) {
        setState("error", "Couldn't start the microphone. Tap the orb to retry.");
      }
    }
  
    // -------------------------------------------------------------------------
    // Talking to the Copilot
    // -------------------------------------------------------------------------
    function startThinkTimers() {
      clearTimers();
      later(() => { if (V.state === "thinking") statusEl.textContent = "Waking the server, one moment…"; }, 8000);
      later(() => { if (V.state === "thinking") statusEl.textContent = "Still working on it…"; }, 22000);
      later(() => {
        if (V.state === "thinking") setState("idle", "That took too long. Tap the orb to try again.");
      }, 60000);
    }
  
    function handleUtterance(text) {
      V.silence = 0;
      youEl.textContent = text;
      youEl.classList.remove("live");
  
      // An approval card is waiting: the answer must be yes or no.
      if (pendingSlip()) {
        const short = text.trim().split(/\s+/).length <= 6;
        if (short && NO.test(text)) { chooseApproval(false); return; }
        if (short && YES.test(text)) { chooseApproval(true); return; }
        speak("I'm waiting for your approval. Please say approve, or cancel.", startListening);
        return;
      }
  
      if (CLOSE.test(text)) { close(); return; }
  
      const api = window.CareOrbit;
      if (!api || typeof api.sendMessage !== "function") {
        setState("error", "Voice isn't connected to the Copilot yet. Check the app.js edits.");
        return;
      }
      if (typeof api.isBusy === "function" && api.isBusy()) {
        setState("idle", "Still finishing the last request…");
        later(startListening, 1500);
        return;
      }
  
      replyEl.textContent = "";
      setState("thinking", "Thinking…");
      startThinkTimers();
      api.sendMessage(text);
    }
  
    function sendTyped(text) {
      const t = (text || "").trim();
      if (!t) return;
      killRecognizer();
      V.speakToken++;
      if (synth) synth.cancel();
      handleUtterance(t);
    }
  
    document.addEventListener("careorbit:reply", (e) => {
      clearTimers();
      if (!V.active) return;
      const d = e.detail || {};
      const reply = String(d.reply || "").trim();
      replyEl.textContent = reply;
      showApproval();
      const waiting = !!pendingSlip();
      speak(reply, () => {
        if (!V.active) return;
        startListening();
        if (waiting) overlay.dataset.approval = "1";
      });
    });
  
    // -------------------------------------------------------------------------
    // Speaking
    // -------------------------------------------------------------------------
    function cleanForSpeech(t) {
      return String(t || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " the link ")
        .replace(/[*_`#>]+/g, "")
        .replace(/^\s*[-•]\s+/gm, "")
        .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, "$1 rupees")
        .replace(/\s*\n+\s*/g, ". ")
        .replace(/([.!?।])\s*\.\s*/g, "$1 ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  
    function chunk(text) {
      const parts = text.match(/[^.!?।]+[.!?।]*\s*/g) || [text];
      const out = [];
      let cur = "";
      for (const p of parts) {
        if ((cur + p).length > 190 && cur) {
          out.push(cur.trim());
          cur = p;
        } else {
          cur += p;
        }
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
  
    function pickVoice(lang) {
      if (!synth) return null;
      const voices = synth.getVoices();
      if (!voices.length) return null;
      const norm = (s) => String(s || "").replace("_", "-").toLowerCase();
      const score = (v) => (/google|natural|neural|online/i.test(v.name) ? 1 : 0);
      const exact = voices.filter((v) => norm(v.lang) === norm(lang));
      const pool = exact.length ? exact : voices.filter((v) => norm(v.lang).startsWith(norm(lang).slice(0, 2)));
      pool.sort((a, b) => score(b) - score(a));
      return pool[0] || null;
    }
    if (synth) {
      synth.getVoices();
      synth.addEventListener && synth.addEventListener("voiceschanged", () => synth.getVoices());
    }
  
    function speak(text, done) {
      const token = ++V.speakToken;
      const finish = () => { if (token === V.speakToken) done(); };
      const clean = cleanForSpeech(text);
  
      if (V.muted || !synth || !clean) {
        later(finish, V.muted ? 300 : 0);
        return;
      }
  
      setState("speaking", "Speaking… tap the orb to interrupt");
      const parts = chunk(clean);
      let i = 0;
      let started = false;
  
      // If the browser never starts speaking (voices not ready), don't hang.
      later(() => {
        if (!started && token === V.speakToken) {
          try { synth.cancel(); } catch (e) {}
          finish();
        }
      }, 5000);
  
      const next = () => {
        if (token !== V.speakToken || !V.active) return;
        if (i >= parts.length) { finish(); return; }
        const u = new SpeechSynthesisUtterance(parts[i++]);
        u.lang = V.lang;
        const voice = pickVoice(V.lang);
        if (voice) u.voice = voice;
        u.rate = 1.03;
        u.pitch = 1;
        u.onstart = () => { started = true; };
        u.onend = next;
        u.onerror = (ev) => {
          if (ev && (ev.error === "interrupted" || ev.error === "canceled")) return;
          next();
        };
        synth.speak(u);
      };
  
      try { synth.cancel(); synth.resume(); } catch (e) {}
      later(next, 60);
    }
  
    // -------------------------------------------------------------------------
    // Open / close and controls
    // -------------------------------------------------------------------------
    function open() {
      V.active = true;
      V.fatal = false;
      V.silence = 0;
      overlay.hidden = false;
      document.body.classList.add("cv-open");
      youEl.classList.remove("live");
      youEl.textContent = "Try: “When does my warranty end?”";
      replyEl.textContent = "";
      showApproval();
      setState("idle", "Starting…");
      orb.focus();
      startListening(); // inside the click, so the browser allows the mic prompt
    }
  
    function close() {
      V.active = false;
      clearTimers();
      killRecognizer();
      V.speakToken++;
      if (synth) synth.cancel();
      overlay.hidden = true;
      document.body.classList.remove("cv-open");
      setState("idle");
      fab.classList.remove("is-live");
      fab.focus();
    }
  
    fab.addEventListener("click", open);
    $("cv-close").addEventListener("click", close);
  
    muteBtn.addEventListener("click", () => {
      V.muted = !V.muted;
      save("careorbit_voice_muted", V.muted ? "1" : "0");
      renderMute();
      if (V.muted && synth) {
        V.speakToken++;
        synth.cancel();
        if (V.active && V.state === "speaking") startListening();
      }
    });
  
    orb.addEventListener("click", () => {
      if (V.state === "speaking") {
        V.speakToken++;
        if (synth) synth.cancel();
        startListening();
        return;
      }
      if (V.state === "listening") {
        if (V.rec) { try { V.rec.stop(); } catch (e) {} }
        return;
      }
      if (V.state === "thinking") return;
      V.fatal = false;
      V.silence = 0;
      startListening();
    });
  
    $("cv-approve").addEventListener("click", () => chooseApproval(true));
    $("cv-cancel").addEventListener("click", () => chooseApproval(false));
  
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = input.value.trim();
      if (!t) return;
      input.value = "";
      sendTyped(t);
    });
  
    document.addEventListener("keydown", (e) => {
      if (V.active && e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
  })();
  