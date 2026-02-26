/* ------------------------------------------------
   Kahoot Bot – Frontend JavaScript
   ------------------------------------------------ */

const socket = io();

// DOM elements
const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const gameoverScreen = document.getElementById("gameover-screen");
const statusLog = document.getElementById("status-log");
const joinBtn = document.getElementById("join-btn");
const pinInput = document.getElementById("pin");
const questionNumber = document.getElementById("question-number");
const questionText = document.getElementById("question-text");
const timerEl = document.getElementById("timer");
const answerButtons = document.querySelectorAll(".answer-btn");

let timerInterval = null;

// ------------------------------------------------------------------
// Screen management
// ------------------------------------------------------------------
function showScreen(screen) {
    [joinScreen, gameScreen, gameoverScreen].forEach((s) =>
        s.classList.remove("active")
    );
    screen.classList.add("active");
}

// ------------------------------------------------------------------
// Join game
// ------------------------------------------------------------------
joinBtn.addEventListener("click", () => {
    const pin = pinInput.value.trim();
    if (!pin) {
        pinInput.focus();
        return;
    }

    joinBtn.disabled = true;
    joinBtn.textContent = "Verbinde...";

    socket.emit("join_game", {
        pin: pin,
        nickname: document.getElementById("nickname").value.trim(),
        quiz_search: document.getElementById("quiz-search").value.trim(),
        quiz_id: document.getElementById("quiz-id").value.trim(),
        auto_answer: document.getElementById("auto-answer").checked,
    });

    // Switch to game screen after short delay
    setTimeout(() => {
        showScreen(gameScreen);
        joinBtn.disabled = false;
        joinBtn.textContent = "Spiel beitreten";
    }, 1000);
});

// Also join on Enter key in PIN field
pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinBtn.click();
});

// ------------------------------------------------------------------
// Socket events
// ------------------------------------------------------------------
socket.on("status", (data) => {
    addStatus(data.message);
});

socket.on("question", (data) => {
    clearTimer();
    questionNumber.textContent = `Frage ${data.index + 1}`;
    questionText.textContent = data.text || "Schau auf den Bildschirm!";
    questionText.classList.add("slide-in");
    setTimeout(() => questionText.classList.remove("slide-in"), 300);

    // Reset answer buttons
    answerButtons.forEach((btn) => {
        btn.classList.remove("highlighted", "correct", "wrong");
        btn.disabled = false;
    });

    // Show only available choices
    answerButtons.forEach((btn, i) => {
        btn.style.display = i < data.num_choices ? "flex" : "none";
    });

    // Highlight suggested answer
    if (data.suggested_answer !== null && data.suggested_answer !== undefined) {
        const suggested = document.querySelector(
            `.answer-btn[data-choice="${data.suggested_answer}"]`
        );
        if (suggested) {
            suggested.classList.add("highlighted");
        }
    }

    // Start countdown timer
    if (data.time_limit) {
        startTimer(data.time_limit / 1000);
    }
});

socket.on("question_end", (data) => {
    clearTimer();
    // Show correct/wrong
    answerButtons.forEach((btn) => {
        btn.disabled = true;
        const choice = parseInt(btn.dataset.choice);
        if (choice === data.correct) {
            btn.classList.add("correct");
        } else {
            btn.classList.add("wrong");
        }
    });

    if (data.points > 0) {
        addStatus(`+${data.points} Punkte!`);
    }
});

socket.on("game_over", (data) => {
    clearTimer();
    document.getElementById("final-rank").textContent = data.rank;
    document.getElementById("final-score").textContent = data.score;
    showScreen(gameoverScreen);
});

socket.on("game_disconnect", (data) => {
    addStatus("Verbindung verloren: " + (data.reason || "Unbekannt"));
});

// ------------------------------------------------------------------
// Answer submission
// ------------------------------------------------------------------
function submitAnswer(choice) {
    socket.emit("submit_answer", { choice: choice });
    answerButtons.forEach((btn) => (btn.disabled = true));
    const clicked = document.querySelector(
        `.answer-btn[data-choice="${choice}"]`
    );
    if (clicked) clicked.classList.add("highlighted");
}

// ------------------------------------------------------------------
// Leave / Reset
// ------------------------------------------------------------------
function leaveGame() {
    socket.emit("leave_game");
    clearTimer();
    showScreen(joinScreen);
}

function resetGame() {
    clearTimer();
    showScreen(joinScreen);
}

// ------------------------------------------------------------------
// Timer
// ------------------------------------------------------------------
function startTimer(seconds) {
    let remaining = Math.ceil(seconds);
    timerEl.textContent = remaining + "s";
    timerInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearTimer();
            timerEl.textContent = "Zeit!";
        } else {
            timerEl.textContent = remaining + "s";
        }
    }, 1000);
}

function clearTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    timerEl.textContent = "";
}

// ------------------------------------------------------------------
// Status log
// ------------------------------------------------------------------
function addStatus(message) {
    const entry = document.createElement("div");
    entry.className = "status-entry";
    entry.textContent = message;
    statusLog.appendChild(entry);

    // Keep only last 20 entries
    while (statusLog.children.length > 20) {
        statusLog.removeChild(statusLog.firstChild);
    }

    // Auto-scroll
    const bar = document.getElementById("status-bar");
    bar.scrollTop = bar.scrollHeight;
}
