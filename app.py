#!/usr/bin/env python3
"""Kahoot Auto-Solver Bot – Flask web server with Socket.IO for
real-time communication between the Kahoot client and the mobile UI."""

import random
import string
import threading

from flask import Flask, render_template
from flask_socketio import SocketIO, emit

from kahoot.client import KahootClient
from kahoot.solver import QuizSolver

app = Flask(__name__)
app.config["SECRET_KEY"] = "kahoot-bot-secret"
socketio = SocketIO(app, cors_allowed_origins="*")

# Active game sessions keyed by Socket.IO session id
sessions: dict[str, dict] = {}


def _random_name() -> str:
    """Generate a random bot nickname."""
    adjectives = ["Schnell", "Schlau", "Cool", "Turbo", "Mega", "Super", "Blitz"]
    nouns = ["Bot", "Player", "Gamer", "Pro", "Solver", "Hacker", "Brain"]
    return random.choice(adjectives) + random.choice(nouns) + "".join(
        random.choices(string.digits, k=2)
    )


@app.route("/")
def index():
    return render_template("index.html")


# ------------------------------------------------------------------
# Socket.IO events
# ------------------------------------------------------------------
@socketio.on("connect")
def handle_connect():
    sessions[_sid()] = {"client": None, "solver": QuizSolver(), "auto": False}
    emit("status", {"message": "Verbunden! Gib einen Spiel-PIN ein."})


@socketio.on("disconnect")
def handle_disconnect():
    sid = _sid()
    session = sessions.pop(sid, None)
    if session and session.get("client"):
        session["client"].leave()


@socketio.on("join_game")
def handle_join(data):
    sid = _sid()
    pin = str(data.get("pin", "")).strip()
    nickname = data.get("nickname", "").strip() or _random_name()
    quiz_search = data.get("quiz_search", "").strip()
    quiz_id = data.get("quiz_id", "").strip()
    auto_answer = data.get("auto_answer", False)

    if not pin:
        emit("status", {"message": "Bitte gib einen Spiel-PIN ein!"})
        return

    session = sessions.get(sid, {})
    solver: QuizSolver = session.get("solver", QuizSolver())
    session["auto"] = auto_answer

    # Try to load quiz answers
    if quiz_id:
        if solver.load_quiz_by_id(quiz_id):
            emit("status", {"message": f"Quiz geladen: {len(solver.quiz_answers)} Fragen gefunden!"})
        else:
            emit("status", {"message": "Quiz-ID konnte nicht geladen werden."})
    elif quiz_search:
        if solver.load_quiz_by_search(quiz_search):
            emit("status", {"message": f"Quiz gefunden: {len(solver.quiz_answers)} Fragen geladen!"})
        else:
            emit("status", {"message": "Kein passendes Quiz gefunden – Antworten zufällig."})

    # Create Kahoot client
    client = KahootClient(pin, nickname)
    session["client"] = client
    sessions[sid] = session

    # Wire up callbacks
    def on_status(msg):
        socketio.emit("status", {"message": msg}, to=sid)

    def on_question(q_index, num_choices, q_text, time_limit):
        answer = solver.find_answer(q_index, q_text, num_choices)
        socketio.emit("question", {
            "index": q_index,
            "num_choices": num_choices,
            "text": q_text,
            "time_limit": time_limit,
            "suggested_answer": answer,
        }, to=sid)
        if auto_answer and answer is not None:
            threading.Timer(0.5, lambda: client.answer(answer)).start()
            socketio.emit("status", {
                "message": f"Auto-Antwort: {_choice_name(answer)}"
            }, to=sid)
        elif auto_answer and answer is None:
            # Random answer as fallback
            rand = random.randint(0, num_choices - 1)
            threading.Timer(0.5, lambda: client.answer(rand)).start()
            socketio.emit("status", {
                "message": f"Keine Antwort gefunden – zufällig: {_choice_name(rand)}"
            }, to=sid)

    def on_question_end(correct_idx, points):
        socketio.emit("question_end", {
            "correct": correct_idx,
            "points": points,
        }, to=sid)

    def on_game_over(rank, score):
        socketio.emit("game_over", {"rank": rank, "score": score}, to=sid)

    def on_disconnect(reason):
        socketio.emit("game_disconnect", {"reason": reason}, to=sid)

    client.on_status = on_status
    client.on_question = on_question
    client.on_question_end = on_question_end
    client.on_game_over = on_game_over
    client.on_disconnect = on_disconnect

    # Join in a background thread so we don't block
    threading.Thread(target=client.join, daemon=True).start()


@socketio.on("submit_answer")
def handle_answer(data):
    sid = _sid()
    session = sessions.get(sid)
    if not session or not session.get("client"):
        return
    choice = int(data.get("choice", 0))
    session["client"].answer(choice)
    emit("status", {"message": f"Antwort gesendet: {_choice_name(choice)}"})


@socketio.on("leave_game")
def handle_leave():
    sid = _sid()
    session = sessions.get(sid)
    if session and session.get("client"):
        session["client"].leave()
        session["client"] = None
    emit("status", {"message": "Spiel verlassen."})


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _sid() -> str:
    from flask import request
    return request.sid  # type: ignore[attr-defined]


def _choice_name(idx: int) -> str:
    names = {0: "Rot (▲)", 1: "Blau (◆)", 2: "Gelb (●)", 3: "Grün (■)"}
    return names.get(idx, str(idx))


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------
if __name__ == "__main__":
    print("\n  Kahoot Auto-Solver Bot")
    print("  Öffne http://localhost:8080 auf deinem Handy!\n")
    socketio.run(app, host="0.0.0.0", port=8080, debug=False, allow_unsafe_werkzeug=True)
