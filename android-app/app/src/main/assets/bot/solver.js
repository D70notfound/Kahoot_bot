/* ═══════════════════════════════════════════════════════════════════════
   Kahoot Bot – Client-Side Solver
   Replaces the Python backend. Searches the Kahoot public API directly
   and provides answer matching – all running in the WebView.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  if (window._kahootSolver) return;

  const SEARCH_URL = "https://create.kahoot.it/rest/kahoots/";
  const QUIZ_DETAIL_URLS = [
    "https://create.kahoot.it/rest/kahoots/{uuid}",
    "https://play.kahoot.it/rest/kahoots/{uuid}",
  ];
  const CHALLENGE_PIN_URL = "https://kahoot.it/rest/challenges/pin/{pin}";

  const solver = {
    quizAnswers: [],
    currentQuizId: null,
    currentQuizTitle: null,
    allLoaded: [],
  };

  // ─── API Functions ──────────────────────────────────────────────

  async function searchQuizzes(query, limit) {
    limit = limit || 20;
    const params = new URLSearchParams({
      query: query,
      cursor: "0",
      limit: String(limit),
      order: "relevance",
      includeExtendedCounters: "false",
    });
    try {
      const resp = await fetch(SEARCH_URL + "?" + params.toString(), {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return data.entities || [];
    } catch (e) {
      return [];
    }
  }

  async function fetchQuizDetails(uuid) {
    for (const tmpl of QUIZ_DETAIL_URLS) {
      const url = tmpl.replace("{uuid}", uuid);
      try {
        const resp = await fetch(url, {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.questions && data.questions.length > 0) return data;
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  async function lookupChallengePin(pin) {
    const url = CHALLENGE_PIN_URL.replace("{pin}", pin);
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.kahootId || data.quizId || (data.kahoot && data.kahoot.uuid) || null;
      }
    } catch (e) {}
    return null;
  }

  function extractAnswers(quiz) {
    const results = [];
    const questions = quiz.questions || [];
    for (const q of questions) {
      const choices = q.choices || [];
      const correctIndices = [];
      const choiceTexts = [];
      for (let i = 0; i < choices.length; i++) {
        if (choices[i].correct) correctIndices.push(i);
        choiceTexts.push(choices[i].answer || "");
      }
      results.push({
        question: q.question || "",
        choices: choiceTexts,
        correct: correctIndices,
        type: q.type || "quiz",
      });
    }
    return results;
  }

  // ─── Text Matching ──────────────────────────────────────────────

  function normalize(text) {
    return text
      .replace(/<[^>]+>/g, "")
      .replace(/&\w+;/g, " ")
      .replace(/[^\w\s]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function similarityRatio(a, b) {
    if (!a || !b) return 0;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    const costs = [];
    for (let i = 0; i <= longer.length; i++) {
      let lastVal = i;
      for (let j = 0; j <= shorter.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newVal = costs[j - 1];
          if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
            newVal = Math.min(Math.min(newVal, lastVal), costs[j]) + 1;
          }
          costs[j - 1] = lastVal;
          lastVal = newVal;
        }
      }
      if (i > 0) costs[shorter.length] = lastVal;
    }
    return (longer.length - costs[shorter.length]) / longer.length;
  }

  function wordOverlap(a, b) {
    if (!a || !b) return 0;
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    return intersection / Math.max(wordsA.size, wordsB.size);
  }

  // ─── Solver Public API ──────────────────────────────────────────

  window._kahootSolver = {
    // Search for a quiz by title and load answers
    search: async function (query) {
      let quizzes = await searchQuizzes(query, 20);
      if (quizzes.length === 0) {
        const simplified = query.replace(/[^\w\s]/g, "").trim();
        if (simplified && simplified !== query) {
          quizzes = await searchQuizzes(simplified, 20);
        }
      }
      if (quizzes.length === 0) {
        return { success: false, error: "Kein Quiz gefunden" };
      }

      const allLoaded = [];
      let bestQuiz = null;
      let bestScore = -1;
      let bestAnswers = [];
      let bestUuid = null;
      let bestTitle = null;

      for (const qs of quizzes) {
        const uuid = (qs.card && qs.card.uuid) || qs.uuid;
        if (!uuid) continue;

        const quiz = await fetchQuizDetails(uuid);
        if (!quiz || !quiz.questions) continue;

        const answers = extractAnswers(quiz);
        allLoaded.push(answers);

        const title = quiz.title || "";
        const score = similarityRatio(normalize(query), normalize(title));
        if (score > bestScore) {
          bestScore = score;
          bestQuiz = quiz;
          bestAnswers = answers;
          bestUuid = uuid;
          bestTitle = title;
        }
      }

      if (bestQuiz) {
        solver.quizAnswers = bestAnswers;
        solver.currentQuizId = bestUuid;
        solver.currentQuizTitle = bestTitle;
        solver.allLoaded = allLoaded;
        return {
          success: true,
          count: bestAnswers.length,
          title: bestTitle || "",
          questions: bestAnswers,
        };
      }
      return { success: false, error: "Kein Quiz gefunden" };
    },

    // Load a quiz by UUID
    loadById: async function (uuid) {
      const quiz = await fetchQuizDetails(uuid);
      if (!quiz) return { success: false, error: "Quiz nicht gefunden" };
      const answers = extractAnswers(quiz);
      solver.quizAnswers = answers;
      solver.currentQuizId = uuid;
      solver.currentQuizTitle = quiz.title || "";
      solver.allLoaded = [answers];
      return {
        success: true,
        count: answers.length,
        title: solver.currentQuizTitle,
        questions: answers,
      };
    },

    // Detect quiz from challenge PIN
    detect: async function (pin) {
      const uuid = await lookupChallengePin(pin);
      if (uuid) {
        const result = await this.loadById(uuid);
        if (result.success) {
          return {
            success: true,
            quiz_id: uuid,
            quiz_title: solver.currentQuizTitle,
            count: result.count,
          };
        }
      }
      return { success: false, error: "Kein Quiz per PIN erkannt" };
    },

    // Find the correct answer for a question
    findAnswer: function (questionIndex, questionText, numChoices) {
      if (solver.quizAnswers.length === 0 && solver.allLoaded.length === 0) {
        return null;
      }

      // Strategy 1: text matching
      if (questionText) {
        const cleanQ = normalize(questionText);
        if (cleanQ) {
          let bestMatch = null;
          let bestScore = 0;
          for (const answers of solver.allLoaded) {
            for (const entry of answers) {
              const cleanE = normalize(entry.question);
              if (!cleanE) continue;
              const score = Math.max(
                similarityRatio(cleanQ, cleanE),
                wordOverlap(cleanQ, cleanE)
              );
              if (score > bestScore) {
                bestScore = score;
                bestMatch = entry;
              }
            }
          }
          if (bestMatch && bestScore > 0.4 && bestMatch.correct.length > 0) {
            return bestMatch.correct[0];
          }
        }
      }

      // Strategy 2: direct index match
      if (questionIndex < solver.quizAnswers.length) {
        const entry = solver.quizAnswers[questionIndex];
        if (entry.correct.length > 0) return entry.correct[0];
      }

      // Strategy 3: index across all loaded
      for (const answers of solver.allLoaded) {
        if (questionIndex < answers.length) {
          const entry = answers[questionIndex];
          if (entry.correct.length > 0) return entry.correct[0];
        }
      }

      return null;
    },

    // Status
    getStatus: function () {
      return {
        loaded: solver.quizAnswers.length > 0,
        quiz_id: solver.currentQuizId,
        quiz_title: solver.currentQuizTitle,
        question_count: solver.quizAnswers.length,
        total_quizzes_loaded: solver.allLoaded.length,
      };
    },
  };
})();
