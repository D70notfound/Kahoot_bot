/* ═══════════════════════════════════════════════════════════════════════
   Kahoot Auto-Solver – Overlay Script
   Injected into the proxied kahoot.it page.
   - Intercepts WebSocket messages to detect questions
   - Queries our backend API for correct answers
   - Highlights and optionally auto-clicks the answer
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────
  const state = {
    quizLoaded: false,
    quizQuestions: [],
    autoAnswer: true,
    autoDelay: 800, // ms before auto-clicking
    questionIndex: -1,
    totalCorrect: 0,
    totalQuestions: 0,
    panelOpen: false,
    minimized: false,
  };

  // ─── WebSocket Interception ──────────────────────────────────────
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    // Rewrite local WebSocket URLs to point directly to kahoot.it
    url = rewriteWsUrl(url);

    const ws =
      protocols != null
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);

    // Listen to all messages for Kahoot game events
    ws.addEventListener("message", function (event) {
      try {
        const messages = JSON.parse(event.data);
        if (Array.isArray(messages)) {
          messages.forEach(handleCometDMessage);
        }
      } catch (e) {
        /* not JSON, ignore */
      }
    });

    return ws;
  };

  // Preserve prototype and static properties
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  function rewriteWsUrl(url) {
    try {
      const u = new URL(url);
      if (
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "0.0.0.0"
      ) {
        u.hostname = "kahoot.it";
        u.port = "";
        u.protocol = "wss:";
        return u.toString();
      }
    } catch (e) {}
    return url;
  }

  // ─── CometD Message Handling ─────────────────────────────────────
  function handleCometDMessage(msg) {
    const channel = msg.channel || "";
    const data = msg.data || {};

    if (channel === "/service/player") {
      handlePlayerMessage(data);
    } else if (channel === "/service/controller") {
      handleControllerMessage(data);
    }
  }

  function handlePlayerMessage(data) {
    const msgId = data.id;
    let content = {};
    try {
      content =
        typeof data.content === "string"
          ? JSON.parse(data.content)
          : data.content || {};
    } catch (e) {
      content = {};
    }

    if (msgId === 1) {
      // ── Question Start ──
      const numChoices = content.numberOfChoices || 4;
      const qIndex = content.questionIndex || 0;
      const timeLimit = content.timeAvailable || 20000;
      const qText = content.questionText || "";

      state.questionIndex = qIndex;
      state.totalQuestions++;

      log(`Frage ${qIndex + 1} (${numChoices} Antworten, ${timeLimit / 1000}s)`);

      // Ask backend for the answer
      fetchAnswer(qIndex, qText, numChoices);
    } else if (msgId === 2) {
      // ── Question End / Results ──
      const correct = content.correctChoices || [];
      const points = content.points || 0;

      if (points > 0) {
        state.totalCorrect++;
        log(`✓ Richtig! +${points} Punkte`);
      } else {
        log("✗ Falsch. Richtig: " + correct.map(choiceName).join(", "));
      }
      updateScoreBadge();
      clearHighlight();
    } else if (msgId === 3) {
      // ── Game Over ──
      const rank = content.rank || "?";
      const score = content.totalScore || 0;
      log(`Spiel vorbei! Platz ${rank} – ${score} Punkte`);
      showGameOver(rank, score);
    }
  }

  function handleControllerMessage(data) {
    if (data.type === "loginResponse") {
      if (data.error) {
        log("Login-Fehler: " + data.error);
      } else {
        log("Im Spiel!");
      }
    }
  }

  // ─── Answer Fetching & Auto-Click ────────────────────────────────
  function fetchAnswer(index, text, numChoices) {
    // First try local quiz data
    if (state.quizLoaded && index < state.quizQuestions.length) {
      const entry = state.quizQuestions[index];
      if (entry.correct && entry.correct.length > 0) {
        const answer = entry.correct[0];
        showAnswer(answer, numChoices);
        if (state.autoAnswer) {
          setTimeout(() => clickAnswer(answer), state.autoDelay);
        }
        return;
      }
    }

    // Ask the backend API
    fetch("/_bot/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, text, num_choices: numChoices }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.answer !== null && data.answer !== undefined) {
          showAnswer(data.answer, numChoices);
          if (state.autoAnswer) {
            setTimeout(() => clickAnswer(data.answer), state.autoDelay);
          }
        } else {
          log("Keine Antwort gefunden");
          showAnswer(null, numChoices);
          // Auto-answer randomly as fallback
          if (state.autoAnswer) {
            const rand = Math.floor(Math.random() * numChoices);
            log("Zufällige Antwort: " + choiceName(rand));
            setTimeout(() => clickAnswer(rand), state.autoDelay);
          }
        }
      })
      .catch(() => {
        log("API-Fehler");
      });
  }

  function clickAnswer(choiceIndex) {
    // Find answer buttons on the Kahoot page
    // Kahoot uses different selectors depending on version
    const selectors = [
      '[data-functional-selector="answer-0"]',
      '[data-functional-selector="answer-1"]',
      '[data-functional-selector="answer-2"]',
      '[data-functional-selector="answer-3"]',
      'button[data-choice]',
      '[class*="answer"]',
    ];

    // Try specific answer button first
    const specificSelectors = [
      `[data-functional-selector="answer-${choiceIndex}"]`,
      `button[data-choice="${choiceIndex}"]`,
    ];

    for (const sel of specificSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        log("Auto-Klick: " + choiceName(choiceIndex));
        return;
      }
    }

    // Fallback: find all answer buttons and click by index
    const allButtons = findAnswerButtons();
    if (choiceIndex < allButtons.length) {
      allButtons[choiceIndex].click();
      log("Auto-Klick: " + choiceName(choiceIndex));
    }
  }

  function findAnswerButtons() {
    // Try multiple strategies to find Kahoot answer buttons
    const strategies = [
      () => document.querySelectorAll('[data-functional-selector^="answer-"]'),
      () => document.querySelectorAll('button[data-choice]'),
      () => {
        // Look for the 4-button answer grid
        const buttons = document.querySelectorAll("button");
        const answerBtns = [];
        buttons.forEach((btn) => {
          const style = window.getComputedStyle(btn);
          const bg = style.backgroundColor;
          // Kahoot answer colors
          if (
            bg.includes("226") || // red
            bg.includes("19") || // blue
            bg.includes("216") || // yellow
            bg.includes("38") // green
          ) {
            answerBtns.push(btn);
          }
        });
        return answerBtns;
      },
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result && result.length >= 2) return Array.from(result);
    }
    return [];
  }

  // ─── Overlay UI ──────────────────────────────────────────────────
  function createOverlay() {
    // Floating Action Button
    const fab = document.createElement("div");
    fab.id = "kb-fab";
    fab.innerHTML = "⚡";
    fab.title = "Kahoot Bot";
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    // Answer indicator (flashes on the side)
    const indicator = document.createElement("div");
    indicator.id = "kb-indicator";
    indicator.innerHTML = "";
    document.body.appendChild(indicator);

    // Panel
    const panel = document.createElement("div");
    panel.id = "kb-panel";
    panel.innerHTML = `
      <div id="kb-panel-header">
        <span>⚡ Kahoot Bot</span>
        <button id="kb-close" title="Schließen">✕</button>
      </div>
      <div id="kb-panel-body">
        <div id="kb-score-badge">0/0 Richtig</div>
        <div class="kb-section">
          <label class="kb-label">Quiz suchen</label>
          <div class="kb-row">
            <input id="kb-search" type="text" placeholder="Quiz-Titel eingeben..." />
            <button id="kb-search-btn">🔍</button>
          </div>
          <div id="kb-search-status" class="kb-hint"></div>
        </div>
        <div class="kb-section">
          <label class="kb-toggle">
            <input id="kb-auto" type="checkbox" checked />
            <span class="kb-slider"></span>
            <span>Auto-Antwort</span>
          </label>
        </div>
        <div class="kb-section">
          <label class="kb-label">Verzögerung</label>
          <div class="kb-row">
            <input id="kb-delay" type="range" min="100" max="3000" value="800" step="100" />
            <span id="kb-delay-val">0.8s</span>
          </div>
        </div>
        <div id="kb-log" class="kb-section"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Event listeners
    document.getElementById("kb-close").addEventListener("click", togglePanel);
    document.getElementById("kb-search-btn").addEventListener("click", searchQuiz);
    document.getElementById("kb-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchQuiz();
    });
    document.getElementById("kb-auto").addEventListener("change", (e) => {
      state.autoAnswer = e.target.checked;
    });
    document.getElementById("kb-delay").addEventListener("input", (e) => {
      state.autoDelay = parseInt(e.target.value);
      document.getElementById("kb-delay-val").textContent =
        (state.autoDelay / 1000).toFixed(1) + "s";
    });

    // Make panel draggable on mobile
    makeDraggable(fab);
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    const panel = document.getElementById("kb-panel");
    panel.classList.toggle("kb-open", state.panelOpen);
  }

  function searchQuiz() {
    const input = document.getElementById("kb-search");
    const query = input.value.trim();
    const statusEl = document.getElementById("kb-search-status");

    if (!query) return;

    statusEl.textContent = "Suche...";

    fetch("/_bot/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          state.quizLoaded = true;
          state.quizQuestions = data.questions;
          statusEl.textContent = `${data.count} Fragen geladen!`;
          statusEl.classList.add("kb-success");
          log(`Quiz geladen: ${data.count} Fragen`);
        } else {
          statusEl.textContent = data.error || "Nicht gefunden";
          statusEl.classList.remove("kb-success");
        }
      })
      .catch(() => {
        statusEl.textContent = "Fehler bei der Suche";
      });
  }

  function showAnswer(choiceIndex, numChoices) {
    const indicator = document.getElementById("kb-indicator");
    if (choiceIndex === null || choiceIndex === undefined) {
      indicator.className = "";
      indicator.textContent = "?";
      indicator.classList.add("kb-show", "kb-unknown");
      setTimeout(() => indicator.classList.remove("kb-show"), 4000);
      return;
    }

    const colors = ["kb-red", "kb-blue", "kb-yellow", "kb-green"];
    const shapes = ["▲", "◆", "●", "■"];

    indicator.className = "";
    indicator.classList.add("kb-show", colors[choiceIndex] || "");
    indicator.textContent = shapes[choiceIndex] || choiceIndex;

    // Also try to highlight the answer button on the page
    highlightAnswer(choiceIndex);

    log("Antwort: " + choiceName(choiceIndex));
  }

  function highlightAnswer(choiceIndex) {
    const buttons = findAnswerButtons();
    buttons.forEach((btn, i) => {
      btn.style.removeProperty("outline");
      btn.style.removeProperty("outline-offset");
      btn.style.removeProperty("box-shadow");
    });
    if (choiceIndex < buttons.length) {
      const target = buttons[choiceIndex];
      target.style.outline = "4px solid white";
      target.style.outlineOffset = "-4px";
      target.style.boxShadow = "0 0 30px rgba(255,255,255,0.6), inset 0 0 30px rgba(255,255,255,0.15)";
    }
  }

  function clearHighlight() {
    const buttons = findAnswerButtons();
    buttons.forEach((btn) => {
      btn.style.removeProperty("outline");
      btn.style.removeProperty("outline-offset");
      btn.style.removeProperty("box-shadow");
    });
    const indicator = document.getElementById("kb-indicator");
    if (indicator) indicator.classList.remove("kb-show");
  }

  function showGameOver(rank, score) {
    const indicator = document.getElementById("kb-indicator");
    indicator.className = "kb-show kb-gameover";
    indicator.innerHTML = `#${rank}<br>${score}`;
  }

  function updateScoreBadge() {
    const badge = document.getElementById("kb-score-badge");
    if (badge) {
      badge.textContent = `${state.totalCorrect}/${state.totalQuestions} Richtig`;
    }
  }

  function log(message) {
    const logEl = document.getElementById("kb-log");
    if (!logEl) return;

    const entry = document.createElement("div");
    entry.className = "kb-log-entry";
    const time = new Date().toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    entry.textContent = `[${time}] ${message}`;
    logEl.appendChild(entry);

    // Keep last 30 entries
    while (logEl.children.length > 30) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ─── Draggable FAB ──────────────────────────────────────────────
  function makeDraggable(el) {
    let startX, startY, startLeft, startTop, dragging = false;

    el.addEventListener("touchstart", (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      dragging = false;
    }, { passive: true });

    el.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        dragging = true;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.left = (startLeft + dx) + "px";
        el.style.top = (startTop + dy) + "px";
      }
    }, { passive: true });

    el.addEventListener("touchend", (e) => {
      if (dragging) {
        e.preventDefault();
      }
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function choiceName(idx) {
    const names = ["Rot ▲", "Blau ◆", "Gelb ●", "Grün ■"];
    return names[idx] || String(idx);
  }

  // ─── Init ────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createOverlay);
  } else {
    createOverlay();
  }

  log("Kahoot Bot bereit!");
})();
