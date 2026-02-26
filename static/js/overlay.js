/* ═══════════════════════════════════════════════════════════════════════
   Kahoot Auto-Solver – Overlay Script
   Injected into the proxied kahoot.it page.
   - Intercepts WebSocket messages to detect questions
   - Intercepts fetch/XHR to detect quiz IDs & names
   - Watches DOM for quiz title in lobby
   - Queries our backend API for correct answers
   - Highlights and optionally auto-clicks the answer
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────
  const state = {
    quizLoaded: false,
    quizQuestions: [],
    quizTitle: "",
    autoAnswer: true,
    autoDelay: 800,
    questionIndex: -1,
    totalCorrect: 0,
    totalQuestions: 0,
    panelOpen: false,
    gamePIN: null,
    detectedQuizId: null,
    detectedQuizTitle: null,
    searchAttempted: false,
    autoDetectDone: false,
  };

  // ═══════════════════════════════════════════════════════════════════
  // 1. WebSocket Interception – detect game events
  // ═══════════════════════════════════════════════════════════════════
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    // Rewrite local WebSocket URLs to point directly to kahoot.it
    url = rewriteWsUrl(url);

    // Extract game PIN from WebSocket URL
    const pinMatch = url.match(/\/cometd\/(\d+)\//);
    if (pinMatch) {
      state.gamePIN = pinMatch[1];
      log("Spiel-PIN erkannt: " + state.gamePIN);
      // Try to auto-detect quiz from PIN (challenge mode)
      tryAutoDetectByPIN(state.gamePIN);
    }

    const ws =
      protocols != null
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);

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

  // ═══════════════════════════════════════════════════════════════════
  // 2. Fetch/XHR Interception – detect quiz IDs and names
  // ═══════════════════════════════════════════════════════════════════
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      inspectFetchResponse(url, response.clone());
    } catch (e) {}
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._botUrl = url;
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    this.addEventListener("load", function () {
      try {
        inspectXHRResponse(self._botUrl, self.responseText);
      } catch (e) {}
    });
    return origXHRSend.apply(this, arguments);
  };

  async function inspectFetchResponse(url, response) {
    // Look for quiz-related API responses
    if (
      url.includes("/kahoots/") ||
      url.includes("/challenges/") ||
      url.includes("/quiz/")
    ) {
      try {
        const data = await response.json();
        extractQuizInfoFromData(data, url);
      } catch (e) {}
    }
  }

  function inspectXHRResponse(url, responseText) {
    if (!url) return;
    if (
      url.includes("/kahoots/") ||
      url.includes("/challenges/") ||
      url.includes("/quiz/")
    ) {
      try {
        const data = JSON.parse(responseText);
        extractQuizInfoFromData(data, url);
      } catch (e) {}
    }
  }

  function extractQuizInfoFromData(data, url) {
    if (!data || typeof data !== "object") return;

    // Look for quiz UUID
    const uuid =
      data.uuid || data.quizId || data.kahootId || data.kahoot?.uuid;
    if (uuid && !state.detectedQuizId) {
      state.detectedQuizId = uuid;
      log("Quiz-ID erkannt: " + uuid.substring(0, 8) + "...");
      autoLoadQuizById(uuid);
      return;
    }

    // Look for quiz title
    const title =
      data.title || data.quizTitle || data.kahoot?.title || data.name;
    if (title && !state.detectedQuizTitle) {
      state.detectedQuizTitle = title;
      log("Quiz-Titel erkannt: " + title);
      if (!state.quizLoaded) {
        autoSearchQuiz(title);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. DOM Observation – detect quiz title from lobby screen
  // ═══════════════════════════════════════════════════════════════════
  let domObserver = null;
  let domCheckInterval = null;

  function startDOMObservation() {
    // Periodic check for quiz title in DOM
    domCheckInterval = setInterval(scanDOMForQuizInfo, 2000);

    // Also observe DOM changes
    domObserver = new MutationObserver(function () {
      scanDOMForQuizInfo();
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function scanDOMForQuizInfo() {
    if (state.quizLoaded || state.autoDetectDone) return;

    // Strategy 1: Look for PIN input to detect when user enters PIN
    const pinInput = document.querySelector(
      'input[data-functional-selector="game-pin-input"], input[name="gameId"], input[type="tel"]'
    );
    if (pinInput && pinInput.value && pinInput.value.length >= 4) {
      if (!state.gamePIN || state.gamePIN !== pinInput.value) {
        state.gamePIN = pinInput.value;
        log("PIN aus Input erkannt: " + state.gamePIN);
      }
    }

    // Strategy 2: Look for quiz title/name in larger text elements
    // Kahoot shows the quiz name on various screens
    const candidates = document.querySelectorAll(
      "h1, h2, h3, [class*='title'], [class*='Title'], [class*='name'], [class*='Name'], [data-functional-selector*='title']"
    );
    for (const el of candidates) {
      const text = el.textContent?.trim();
      if (
        text &&
        text.length > 3 &&
        text.length < 200 &&
        !text.match(/^(Kahoot|Enter|Game|Waiting|Loading|PIN|Nickname)/i) &&
        !text.includes("localhost") &&
        !text.includes("kahoot.it")
      ) {
        // Could be a quiz title
        if (
          !state.detectedQuizTitle ||
          state.detectedQuizTitle !== text
        ) {
          state.detectedQuizTitle = text;
          log("Möglicher Quiz-Titel: " + text);
          if (!state.quizLoaded && !state.searchAttempted) {
            autoSearchQuiz(text);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. Auto-Detection Actions
  // ═══════════════════════════════════════════════════════════════════
  function tryAutoDetectByPIN(pin) {
    if (state.quizLoaded) return;

    fetch("/_bot/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.quiz_id) {
          state.detectedQuizId = data.quiz_id;
          log("Quiz per PIN erkannt: " + (data.quiz_title || data.quiz_id));
          autoLoadQuizById(data.quiz_id);
        }
      })
      .catch(() => {});
  }

  function autoLoadQuizById(uuid) {
    if (state.quizLoaded) return;
    state.autoDetectDone = true;

    log("Lade Quiz automatisch...");
    fetch("/_bot/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quiz_id: uuid }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          state.quizLoaded = true;
          state.quizQuestions = data.questions;
          state.quizTitle = data.title || "";
          log("Quiz geladen: " + data.count + " Fragen");
          updateSearchStatus(data.count + " Fragen geladen!", true);
          updateSearchField(state.quizTitle || uuid);
        } else {
          log("Quiz konnte nicht geladen werden");
        }
      })
      .catch(() => log("Fehler beim Quiz laden"));
  }

  function autoSearchQuiz(title) {
    if (state.quizLoaded || state.searchAttempted) return;
    state.searchAttempted = true;

    log("Auto-Suche: " + title);
    updateSearchField(title);
    doSearch(title);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. CometD Message Handling
  // ═══════════════════════════════════════════════════════════════════
  function handleCometDMessage(msg) {
    const channel = msg.channel || "";
    const data = msg.data || {};

    if (channel === "/service/player") {
      handlePlayerMessage(data);
    } else if (channel === "/service/controller") {
      handleControllerMessage(data);
    } else if (channel === "/service/status") {
      handleStatusMessage(data);
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

    // Check for quiz info in any player message
    if (content.quizId || content.quizName || content.quizTitle) {
      const id = content.quizId;
      const title = content.quizName || content.quizTitle;
      if (id && !state.detectedQuizId) {
        state.detectedQuizId = id;
        autoLoadQuizById(id);
      } else if (title && !state.quizLoaded) {
        autoSearchQuiz(title);
      }
    }

    if (msgId === 1) {
      // ── Question Start ──
      const numChoices = content.numberOfChoices || 4;
      const qIndex = content.questionIndex ?? 0;
      const timeLimit = content.timeAvailable || 20000;
      const qText = content.questionText || "";

      state.questionIndex = qIndex;
      state.totalQuestions++;

      log(
        "Frage " +
          (qIndex + 1) +
          " (" +
          numChoices +
          " Antworten, " +
          (timeLimit / 1000) +
          "s)"
      );

      fetchAnswer(qIndex, qText, numChoices);
    } else if (msgId === 2) {
      // ── Question End / Results ──
      const correct = content.correctChoices || content.correctAnswers || [];
      const points = content.points || content.pointsData?.totalPointsWithBonuses || 0;

      if (points > 0) {
        state.totalCorrect++;
        log("Richtig! +" + points + " Punkte");
      } else {
        const names = correct.map(choiceName).join(", ");
        log("Falsch. Richtig war: " + names);
      }
      updateScoreBadge();
      clearHighlight();
    } else if (msgId === 3) {
      // ── Game Over ──
      const rank = content.rank || "?";
      const score = content.totalScore || 0;
      log("Spiel vorbei! Platz " + rank + " - " + score + " Punkte");
      showGameOver(rank, score);
      // Reset for next game
      state.searchAttempted = false;
      state.autoDetectDone = false;
    } else if (msgId === 9) {
      // ── Play Again ──
      state.totalCorrect = 0;
      state.totalQuestions = 0;
      state.questionIndex = -1;
      updateScoreBadge();
      log("Neues Spiel...");
    } else if (msgId === 14 || msgId === 15) {
      // ── Get Ready / Start Quiz ──
      log("Spiel startet...");
    }
  }

  function handleControllerMessage(data) {
    let content = {};
    try {
      content =
        typeof data.content === "string"
          ? JSON.parse(data.content)
          : data.content || {};
    } catch (e) {
      content = {};
    }

    if (data.type === "loginResponse") {
      if (data.error) {
        log("Login-Fehler: " + data.error);
      } else {
        log("Im Spiel!");
        // After successful login, start DOM observation
        startDOMObservation();
      }
    }

    // Check for quiz info in controller messages
    if (content.quizId) {
      if (!state.detectedQuizId) {
        state.detectedQuizId = content.quizId;
        autoLoadQuizById(content.quizId);
      }
    }
  }

  function handleStatusMessage(data) {
    // Status messages might contain game/quiz info
    let content = {};
    try {
      content =
        typeof data.content === "string"
          ? JSON.parse(data.content)
          : data.content || {};
    } catch (e) {
      content = {};
    }

    if (content.quizId && !state.detectedQuizId) {
      state.detectedQuizId = content.quizId;
      autoLoadQuizById(content.quizId);
    }
    if (content.quizName && !state.quizLoaded) {
      autoSearchQuiz(content.quizName);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 6. Answer Fetching & Auto-Click
  // ═══════════════════════════════════════════════════════════════════
  function fetchAnswer(index, text, numChoices) {
    // Ask the backend API (it handles both index and text matching)
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
          if (state.autoAnswer) {
            const rand = Math.floor(Math.random() * numChoices);
            log("Zufällig: " + choiceName(rand));
            setTimeout(() => clickAnswer(rand), state.autoDelay);
          }
        }
      })
      .catch(() => {
        log("API-Fehler");
        if (state.autoAnswer) {
          const rand = Math.floor(Math.random() * numChoices);
          setTimeout(() => clickAnswer(rand), state.autoDelay);
        }
      });
  }

  function clickAnswer(choiceIndex) {
    // Try specific selectors first
    const specificSelectors = [
      '[data-functional-selector="answer-' + choiceIndex + '"]',
      'button[data-choice="' + choiceIndex + '"]',
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
    } else {
      log("Konnte Button nicht finden!");
    }
  }

  function findAnswerButtons() {
    const strategies = [
      () => document.querySelectorAll('[data-functional-selector^="answer-"]'),
      () => document.querySelectorAll('button[data-choice]'),
      () => {
        // Look for answer containers (Kahoot uses colored divs/buttons)
        const containers = document.querySelectorAll(
          '[class*="answer-container"], [class*="AnswerContainer"], [class*="answer-button"]'
        );
        if (containers.length >= 2) return containers;

        // Look for the large colored buttons
        const allBtns = document.querySelectorAll("button, [role='button']");
        const answerBtns = [];
        allBtns.forEach((btn) => {
          const rect = btn.getBoundingClientRect();
          // Answer buttons are large and visible
          if (rect.width > 60 && rect.height > 40 && rect.top > 100) {
            const style = window.getComputedStyle(btn);
            const bg = style.backgroundColor;
            // Check for Kahoot answer colors
            if (
              bg.includes("226") || bg.includes("228") || // red
              bg.includes("19")  || bg.includes("104") || // blue
              bg.includes("216") || bg.includes("158") || // yellow/orange
              bg.includes("38")  || bg.includes("137")    // green
            ) {
              answerBtns.push(btn);
            }
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

  // ═══════════════════════════════════════════════════════════════════
  // 7. Overlay UI
  // ═══════════════════════════════════════════════════════════════════
  function createOverlay() {
    // Floating Action Button
    const fab = document.createElement("div");
    fab.id = "kb-fab";
    fab.innerHTML = "&#9889;";
    fab.title = "Kahoot Bot";
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    // Answer indicator (center of screen)
    const indicator = document.createElement("div");
    indicator.id = "kb-indicator";
    document.body.appendChild(indicator);

    // Panel
    const panel = document.createElement("div");
    panel.id = "kb-panel";
    panel.innerHTML =
      '<div id="kb-panel-header">' +
      "  <span>&#9889; Kahoot Bot</span>" +
      '  <button id="kb-close" title="Schliessen">&times;</button>' +
      "</div>" +
      '<div id="kb-panel-body">' +
      '  <div id="kb-score-badge">0/0 Richtig</div>' +
      '  <div class="kb-section">' +
      '    <label class="kb-label">Quiz suchen</label>' +
      '    <div class="kb-row">' +
      '      <input id="kb-search" type="text" placeholder="Quiz-Titel eingeben..." />' +
      '      <button id="kb-search-btn">&#128269;</button>' +
      "    </div>" +
      '    <div id="kb-search-status" class="kb-hint"></div>' +
      "  </div>" +
      '  <div class="kb-section">' +
      '    <label class="kb-toggle">' +
      '      <input id="kb-auto" type="checkbox" checked />' +
      '      <span class="kb-slider"></span>' +
      "      <span>Auto-Antwort</span>" +
      "    </label>" +
      "  </div>" +
      '  <div class="kb-section">' +
      '    <label class="kb-label">Verz&ouml;gerung</label>' +
      '    <div class="kb-row">' +
      '      <input id="kb-delay" type="range" min="100" max="3000" value="800" step="100" />' +
      '      <span id="kb-delay-val">0.8s</span>' +
      "    </div>" +
      "  </div>" +
      '  <div id="kb-log" class="kb-section"></div>' +
      "</div>";
    document.body.appendChild(panel);

    // Event listeners
    document.getElementById("kb-close").addEventListener("click", togglePanel);
    document
      .getElementById("kb-search-btn")
      .addEventListener("click", function () {
        const input = document.getElementById("kb-search");
        const query = input.value.trim();
        if (query) {
          state.searchAttempted = true;
          doSearch(query);
        }
      });
    document
      .getElementById("kb-search")
      .addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          const query = e.target.value.trim();
          if (query) {
            state.searchAttempted = true;
            doSearch(query);
          }
        }
      });
    document
      .getElementById("kb-auto")
      .addEventListener("change", function (e) {
        state.autoAnswer = e.target.checked;
      });
    document
      .getElementById("kb-delay")
      .addEventListener("input", function (e) {
        state.autoDelay = parseInt(e.target.value);
        document.getElementById("kb-delay-val").textContent =
          (state.autoDelay / 1000).toFixed(1) + "s";
      });

    makeDraggable(fab);
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    document
      .getElementById("kb-panel")
      .classList.toggle("kb-open", state.panelOpen);
  }

  function doSearch(query) {
    updateSearchStatus("Suche...", false);

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
          state.quizTitle = data.title || query;
          updateSearchStatus(data.count + " Fragen geladen!", true);
          log("Quiz geladen: " + data.count + " Fragen");
        } else {
          updateSearchStatus(data.error || "Nicht gefunden", false);
          log("Suche fehlgeschlagen: " + (data.error || ""));
          // Allow retry
          state.searchAttempted = false;
        }
      })
      .catch(function () {
        updateSearchStatus("Fehler bei der Suche", false);
        state.searchAttempted = false;
      });
  }

  function updateSearchStatus(text, success) {
    const el = document.getElementById("kb-search-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("kb-success", !!success);
  }

  function updateSearchField(text) {
    const el = document.getElementById("kb-search");
    if (el && text) {
      el.value = text;
    }
  }

  function showAnswer(choiceIndex, numChoices) {
    const indicator = document.getElementById("kb-indicator");
    if (!indicator) return;

    if (choiceIndex === null || choiceIndex === undefined) {
      indicator.className = "kb-show kb-unknown";
      indicator.textContent = "?";
      setTimeout(function () {
        indicator.classList.remove("kb-show");
      }, 4000);
      return;
    }

    var colors = ["kb-red", "kb-blue", "kb-yellow", "kb-green"];
    var shapes = ["\u25B2", "\u25C6", "\u25CF", "\u25A0"];

    indicator.className = "kb-show " + (colors[choiceIndex] || "");
    indicator.textContent = shapes[choiceIndex] || String(choiceIndex);

    highlightAnswer(choiceIndex);
    log("Antwort: " + choiceName(choiceIndex));
  }

  function highlightAnswer(choiceIndex) {
    var buttons = findAnswerButtons();
    buttons.forEach(function (btn) {
      btn.style.removeProperty("outline");
      btn.style.removeProperty("outline-offset");
      btn.style.removeProperty("box-shadow");
    });
    if (choiceIndex < buttons.length) {
      var target = buttons[choiceIndex];
      target.style.outline = "4px solid white";
      target.style.outlineOffset = "-4px";
      target.style.boxShadow =
        "0 0 30px rgba(255,255,255,0.6), inset 0 0 30px rgba(255,255,255,0.15)";
    }
  }

  function clearHighlight() {
    var buttons = findAnswerButtons();
    buttons.forEach(function (btn) {
      btn.style.removeProperty("outline");
      btn.style.removeProperty("outline-offset");
      btn.style.removeProperty("box-shadow");
    });
    var indicator = document.getElementById("kb-indicator");
    if (indicator) indicator.classList.remove("kb-show");
  }

  function showGameOver(rank, score) {
    var indicator = document.getElementById("kb-indicator");
    if (!indicator) return;
    indicator.className = "kb-show kb-gameover";
    indicator.innerHTML = "#" + rank + "<br>" + score;
  }

  function updateScoreBadge() {
    var badge = document.getElementById("kb-score-badge");
    if (badge) {
      badge.textContent =
        state.totalCorrect + "/" + state.totalQuestions + " Richtig";
    }
  }

  function log(message) {
    var logEl = document.getElementById("kb-log");
    if (!logEl) {
      // Queue for later
      console.log("[KahootBot]", message);
      return;
    }

    var entry = document.createElement("div");
    entry.className = "kb-log-entry";
    var time = new Date().toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    entry.textContent = "[" + time + "] " + message;
    logEl.appendChild(entry);

    while (logEl.children.length > 50) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ─── Draggable FAB ──────────────────────────────────────────────
  function makeDraggable(el) {
    var startX, startY, startLeft, startTop;
    var dragging = false;

    el.addEventListener(
      "touchstart",
      function (e) {
        var touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        var rect = el.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        dragging = false;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchmove",
      function (e) {
        var touch = e.touches[0];
        var dx = touch.clientX - startX;
        var dy = touch.clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          dragging = true;
          el.style.right = "auto";
          el.style.bottom = "auto";
          el.style.left = startLeft + dx + "px";
          el.style.top = startTop + dy + "px";
        }
      },
      { passive: true }
    );

    el.addEventListener("touchend", function (e) {
      if (dragging) {
        e.preventDefault();
      }
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function choiceName(idx) {
    var names = ["Rot \u25B2", "Blau \u25C6", "Gelb \u25CF", "Gr\u00FCn \u25A0"];
    return names[idx] || String(idx);
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    createOverlay();
    log("Kahoot Bot bereit!");
    log("Quiz wird automatisch erkannt oder manuell suchen.");
    // Start DOM observation early
    startDOMObservation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
