/* ═══════════════════════════════════════════════════════════════════════
   Kahoot Auto-Solver – Overlay Script (Android Standalone Version)
   Uses _kahootSolver (solver.js) instead of backend API calls.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  if (window._kahootOverlayLoaded) return;
  window._kahootOverlayLoaded = true;

  var solver = window._kahootSolver;
  if (!solver) {
    console.error("[KahootBot] solver.js not loaded!");
    return;
  }

  // ─── State ───────────────────────────────────────────────────────
  var state = {
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
  // 1. WebSocket Interception
  // ═══════════════════════════════════════════════════════════════════
  var OriginalWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    var pinMatch = url.match(/\/cometd\/(\d+)\//);
    if (pinMatch) {
      state.gamePIN = pinMatch[1];
      log("Spiel-PIN erkannt: " + state.gamePIN);
      tryAutoDetectByPIN(state.gamePIN);
    }

    var ws =
      protocols != null
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);

    ws.addEventListener("message", function (event) {
      try {
        var messages = JSON.parse(event.data);
        if (Array.isArray(messages)) {
          messages.forEach(handleCometDMessage);
        }
      } catch (e) {}
    });

    return ws;
  };

  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // ═══════════════════════════════════════════════════════════════════
  // 2. Fetch/XHR Interception
  // ═══════════════════════════════════════════════════════════════════
  var origFetch = window.fetch;
  window.fetch = async function (input, init) {
    var response = await origFetch.apply(this, arguments);
    try {
      var url = typeof input === "string" ? input : input && input.url ? input.url : "";
      inspectFetchResponse(url, response.clone());
    } catch (e) {}
    return response;
  };

  var origXHROpen = XMLHttpRequest.prototype.open;
  var origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._botUrl = url;
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    this.addEventListener("load", function () {
      try {
        inspectXHRResponse(self._botUrl, self.responseText);
      } catch (e) {}
    });
    return origXHRSend.apply(this, arguments);
  };

  async function inspectFetchResponse(url, response) {
    if (url.includes("/kahoots/") || url.includes("/challenges/") || url.includes("/quiz/")) {
      try {
        var data = await response.json();
        extractQuizInfoFromData(data, url);
      } catch (e) {}
    }
  }

  function inspectXHRResponse(url, responseText) {
    if (!url) return;
    if (url.includes("/kahoots/") || url.includes("/challenges/") || url.includes("/quiz/")) {
      try {
        var data = JSON.parse(responseText);
        extractQuizInfoFromData(data, url);
      } catch (e) {}
    }
  }

  function extractQuizInfoFromData(data, url) {
    if (!data || typeof data !== "object") return;
    var uuid = data.uuid || data.quizId || data.kahootId || (data.kahoot && data.kahoot.uuid);
    if (uuid && !state.detectedQuizId) {
      state.detectedQuizId = uuid;
      log("Quiz-ID erkannt: " + uuid.substring(0, 8) + "...");
      autoLoadQuizById(uuid);
      return;
    }
    var title = data.title || data.quizTitle || (data.kahoot && data.kahoot.title) || data.name;
    if (title && !state.detectedQuizTitle) {
      state.detectedQuizTitle = title;
      log("Quiz-Titel erkannt: " + title);
      if (!state.quizLoaded) {
        autoSearchQuiz(title);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. DOM Observation
  // ═══════════════════════════════════════════════════════════════════
  var domObserver = null;
  var domCheckInterval = null;

  function startDOMObservation() {
    domCheckInterval = setInterval(scanDOMForQuizInfo, 2000);
    domObserver = new MutationObserver(function () {
      scanDOMForQuizInfo();
    });
    if (document.body) {
      domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  function scanDOMForQuizInfo() {
    if (state.quizLoaded || state.autoDetectDone) return;

    var pinInput = document.querySelector(
      'input[data-functional-selector="game-pin-input"], input[name="gameId"], input[type="tel"]'
    );
    if (pinInput && pinInput.value && pinInput.value.length >= 4) {
      if (!state.gamePIN || state.gamePIN !== pinInput.value) {
        state.gamePIN = pinInput.value;
        log("PIN aus Input erkannt: " + state.gamePIN);
      }
    }

    var candidates = document.querySelectorAll(
      "h1, h2, h3, [class*='title'], [class*='Title'], [class*='name'], [class*='Name']"
    );
    for (var i = 0; i < candidates.length; i++) {
      var text = candidates[i].textContent && candidates[i].textContent.trim();
      if (
        text &&
        text.length > 3 &&
        text.length < 200 &&
        !text.match(/^(Kahoot|Enter|Game|Waiting|Loading|PIN|Nickname)/i) &&
        !text.includes("localhost") &&
        !text.includes("kahoot.it")
      ) {
        if (!state.detectedQuizTitle || state.detectedQuizTitle !== text) {
          state.detectedQuizTitle = text;
          log("Moeglicher Quiz-Titel: " + text);
          if (!state.quizLoaded && !state.searchAttempted) {
            autoSearchQuiz(text);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. Auto-Detection (uses client-side solver)
  // ═══════════════════════════════════════════════════════════════════
  function tryAutoDetectByPIN(pin) {
    if (state.quizLoaded) return;
    solver.detect(pin).then(function (data) {
      if (data.success && data.quiz_id) {
        state.detectedQuizId = data.quiz_id;
        log("Quiz per PIN erkannt: " + (data.quiz_title || data.quiz_id));
        autoLoadQuizById(data.quiz_id);
      }
    }).catch(function () {});
  }

  function autoLoadQuizById(uuid) {
    if (state.quizLoaded) return;
    state.autoDetectDone = true;
    log("Lade Quiz automatisch...");
    solver.loadById(uuid).then(function (data) {
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
    }).catch(function () {
      log("Fehler beim Quiz laden");
    });
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
    var channel = msg.channel || "";
    var data = msg.data || {};
    if (channel === "/service/player") handlePlayerMessage(data);
    else if (channel === "/service/controller") handleControllerMessage(data);
    else if (channel === "/service/status") handleStatusMessage(data);
  }

  function handlePlayerMessage(data) {
    var msgId = data.id;
    var content = {};
    try {
      content = typeof data.content === "string" ? JSON.parse(data.content) : data.content || {};
    } catch (e) {
      content = {};
    }

    if (content.quizId || content.quizName || content.quizTitle) {
      var id = content.quizId;
      var title = content.quizName || content.quizTitle;
      if (id && !state.detectedQuizId) {
        state.detectedQuizId = id;
        autoLoadQuizById(id);
      } else if (title && !state.quizLoaded) {
        autoSearchQuiz(title);
      }
    }

    if (msgId === 1) {
      var numChoices = content.numberOfChoices || 4;
      var qIndex = content.questionIndex != null ? content.questionIndex : 0;
      var timeLimit = content.timeAvailable || 20000;
      var qText = content.questionText || "";
      state.questionIndex = qIndex;
      state.totalQuestions++;
      log("Frage " + (qIndex + 1) + " (" + numChoices + " Antworten, " + (timeLimit / 1000) + "s)");
      fetchAnswer(qIndex, qText, numChoices);
    } else if (msgId === 2) {
      var correct = content.correctChoices || content.correctAnswers || [];
      var points = content.points || (content.pointsData && content.pointsData.totalPointsWithBonuses) || 0;
      var isCorrect = content.isCorrect === true || content.correct === true || points > 0;
      if (isCorrect) {
        state.totalCorrect++;
        log("Richtig! +" + points + " Punkte");
      } else {
        var names = correct.map(choiceName).join(", ");
        log("Falsch. Richtig war: " + (names || "unbekannt"));
      }
      updateScoreBadge();
      clearHighlight();
    } else if (msgId === 3) {
      var rank = content.rank || "?";
      var score = content.totalScore || 0;
      log("Spiel vorbei! Platz " + rank + " - " + score + " Punkte");
      showGameOver(rank, score);
      state.searchAttempted = false;
      state.autoDetectDone = false;
    } else if (msgId === 9) {
      state.totalCorrect = 0;
      state.totalQuestions = 0;
      state.questionIndex = -1;
      updateScoreBadge();
      log("Neues Spiel...");
    } else if (msgId === 14 || msgId === 15) {
      log("Spiel startet...");
    }
  }

  function handleControllerMessage(data) {
    var content = {};
    try {
      content = typeof data.content === "string" ? JSON.parse(data.content) : data.content || {};
    } catch (e) {
      content = {};
    }
    if (data.type === "loginResponse") {
      if (data.error) {
        log("Login-Fehler: " + data.error);
      } else {
        log("Im Spiel!");
        startDOMObservation();
      }
    }
    if (content.quizId && !state.detectedQuizId) {
      state.detectedQuizId = content.quizId;
      autoLoadQuizById(content.quizId);
    }
  }

  function handleStatusMessage(data) {
    var content = {};
    try {
      content = typeof data.content === "string" ? JSON.parse(data.content) : data.content || {};
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
  // 6. Answer Fetching & Auto-Click (uses client-side solver)
  // ═══════════════════════════════════════════════════════════════════
  function fetchAnswer(index, text, numChoices) {
    var answer = solver.findAnswer(index, text, numChoices);
    if (answer !== null && answer !== undefined) {
      showAnswer(answer, numChoices);
      if (state.autoAnswer) {
        setTimeout(function () { clickAnswer(answer); }, state.autoDelay);
      }
    } else {
      log("Keine Antwort gefunden");
      showAnswer(null, numChoices);
      if (state.autoAnswer) {
        var rand = Math.floor(Math.random() * numChoices);
        log("Zufaellig: " + choiceName(rand));
        setTimeout(function () { clickAnswer(rand); }, state.autoDelay);
      }
    }
  }

  function clickAnswer(choiceIndex) {
    var specificSelectors = [
      '[data-functional-selector="answer-' + choiceIndex + '"]',
      'button[data-choice="' + choiceIndex + '"]',
    ];
    for (var s = 0; s < specificSelectors.length; s++) {
      var btn = document.querySelector(specificSelectors[s]);
      if (btn) {
        btn.click();
        log("Auto-Klick: " + choiceName(choiceIndex));
        return;
      }
    }
    var allButtons = findAnswerButtons();
    if (choiceIndex < allButtons.length) {
      allButtons[choiceIndex].click();
      log("Auto-Klick: " + choiceName(choiceIndex));
    } else {
      log("Konnte Button nicht finden!");
    }
  }

  function findAnswerButtons() {
    var strategies = [
      function () { return document.querySelectorAll('[data-functional-selector^="answer-"]'); },
      function () { return document.querySelectorAll('button[data-choice]'); },
      function () {
        var containers = document.querySelectorAll(
          '[class*="answer-container"], [class*="AnswerContainer"], [class*="answer-button"], [class*="choice"]'
        );
        if (containers.length >= 2) return containers;
        var allBtns = document.querySelectorAll("button, [role='button'], [class*='answer']");
        var candidates = [];
        allBtns.forEach(function (btn) {
          var rect = btn.getBoundingClientRect();
          if (rect.width > 60 && rect.height > 40 && rect.top > 100 &&
              rect.bottom <= window.innerHeight && btn.offsetParent !== null) {
            candidates.push({ el: btn, w: Math.round(rect.width), h: Math.round(rect.height) });
          }
        });
        var groups = [];
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          var placed = false;
          for (var gi = 0; gi < groups.length; gi++) {
            if (Math.abs(groups[gi][0].w - c.w) < 20 && Math.abs(groups[gi][0].h - c.h) < 20) {
              groups[gi].push(c);
              placed = true;
              break;
            }
          }
          if (!placed) groups.push([c]);
        }
        for (var gi2 = 0; gi2 < groups.length; gi2++) {
          if (groups[gi2].length >= 2 && groups[gi2].length <= 4) {
            return groups[gi2].map(function (c) { return c.el; });
          }
        }
        return [];
      },
    ];
    for (var si = 0; si < strategies.length; si++) {
      var result = strategies[si]();
      if (result && result.length >= 2) return Array.from(result);
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. Overlay UI
  // ═══════════════════════════════════════════════════════════════════
  function createOverlay() {
    var fab = document.createElement("div");
    fab.id = "kb-fab";
    fab.innerHTML = "&#9889;";
    fab.title = "Kahoot Bot";
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    var indicator = document.createElement("div");
    indicator.id = "kb-indicator";
    document.body.appendChild(indicator);

    var panel = document.createElement("div");
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

    document.getElementById("kb-close").addEventListener("click", togglePanel);
    document.getElementById("kb-search-btn").addEventListener("click", function () {
      var input = document.getElementById("kb-search");
      var query = input.value.trim();
      if (query) {
        state.searchAttempted = true;
        doSearch(query);
      }
    });
    document.getElementById("kb-search").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var query = e.target.value.trim();
        if (query) {
          state.searchAttempted = true;
          doSearch(query);
        }
      }
    });
    document.getElementById("kb-auto").addEventListener("change", function (e) {
      state.autoAnswer = e.target.checked;
    });
    document.getElementById("kb-delay").addEventListener("input", function (e) {
      state.autoDelay = parseInt(e.target.value);
      document.getElementById("kb-delay-val").textContent =
        (state.autoDelay / 1000).toFixed(1) + "s";
    });

    makeDraggable(fab);
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    document.getElementById("kb-panel").classList.toggle("kb-open", state.panelOpen);
  }

  function doSearch(query) {
    updateSearchStatus("Suche...", false);
    solver.search(query).then(function (data) {
      if (data.success) {
        state.quizLoaded = true;
        state.quizQuestions = data.questions;
        state.quizTitle = data.title || query;
        updateSearchStatus(data.count + " Fragen geladen!", true);
        log("Quiz geladen: " + data.count + " Fragen");
      } else {
        updateSearchStatus(data.error || "Nicht gefunden", false);
        log("Suche fehlgeschlagen: " + (data.error || ""));
        state.searchAttempted = false;
      }
    }).catch(function () {
      updateSearchStatus("Fehler bei der Suche", false);
      state.searchAttempted = false;
    });
  }

  function updateSearchStatus(text, success) {
    var el = document.getElementById("kb-search-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("kb-success", !!success);
  }

  function updateSearchField(text) {
    var el = document.getElementById("kb-search");
    if (el && text) el.value = text;
  }

  function showAnswer(choiceIndex, numChoices) {
    var indicator = document.getElementById("kb-indicator");
    if (!indicator) return;
    if (choiceIndex === null || choiceIndex === undefined) {
      indicator.className = "kb-show kb-unknown";
      indicator.textContent = "?";
      setTimeout(function () { indicator.classList.remove("kb-show"); }, 4000);
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
      target.style.boxShadow = "0 0 30px rgba(255,255,255,0.6), inset 0 0 30px rgba(255,255,255,0.15)";
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
      badge.textContent = state.totalCorrect + "/" + state.totalQuestions + " Richtig";
    }
  }

  function log(message) {
    var logEl = document.getElementById("kb-log");
    if (!logEl) {
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
    el.addEventListener("touchstart", function (e) {
      var touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      var rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      dragging = false;
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      var touch = e.touches[0];
      var dx = touch.clientX - startX;
      var dy = touch.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        dragging = true;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.left = (startLeft + dx) + "px";
        el.style.top = (startTop + dy) + "px";
      }
    }, { passive: true });
    el.addEventListener("touchend", function (e) {
      if (dragging) e.preventDefault();
    });
  }

  function choiceName(idx) {
    var names = ["Rot \u25B2", "Blau \u25C6", "Gelb \u25CF", "Gr\u00FCn \u25A0"];
    return names[idx] || String(idx);
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    createOverlay();
    log("Kahoot Bot bereit!");
    log("Quiz wird automatisch erkannt oder manuell suchen.");
    startDOMObservation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
