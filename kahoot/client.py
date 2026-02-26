"""Kahoot game client – handles session reservation, token decoding, and
CometD WebSocket communication for joining and playing Kahoot games."""

import base64
import json
import re
import threading
import time
from typing import Callable, Optional

import requests
import websocket

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
KAHOOT_BASE = "https://kahoot.it"
KAHOOT_API = "https://create.kahoot.it/rest/kahoots"

ANSWER_NAMES = {0: "Red", 1: "Blue", 2: "Yellow", 3: "Green"}


# ---------------------------------------------------------------------------
# Token / challenge helpers
# ---------------------------------------------------------------------------
def _decode_challenge(challenge_text: str) -> str:
    """Evaluate the Kahoot JS challenge and return the offset string.

    The challenge looks like:
      decode.call(this, 'ENCODED', function(…){ return <expr>; })
    We extract the encoded string and the offset expression, evaluate the
    offset with a minimal safe eval, and XOR to produce the session token.
    """
    # Extract the encoded string (first argument to decode.call)
    match = re.search(r"decode\.call\(this,\s*'([^']+)'", challenge_text)
    if not match:
        raise ValueError("Could not extract encoded string from challenge")
    encoded = match.group(1)

    # Extract the offset expression – the body of the inner function
    fn_match = re.search(r"function\s*\(.*?\)\s*\{(.*?)\}", challenge_text, re.DOTALL)
    if not fn_match:
        raise ValueError("Could not extract challenge function body")
    body = fn_match.group(1).strip()

    # The body is typically "return <expr>;" – extract the expression
    ret_match = re.search(r"return\s+(.+?);", body)
    if not ret_match:
        raise ValueError("Could not extract return expression from challenge")
    expr = ret_match.group(1).strip()

    # Safe-evaluate the arithmetic expression (only digits and operators)
    expr_clean = re.sub(r"[^0-9+\-*/%() ]", "", expr)
    if not expr_clean:
        raise ValueError("Challenge expression is empty after sanitization")
    offset_val = eval(expr_clean)  # noqa: S307 – intentionally limited

    return _xor_decode(encoded, offset_val)


def _xor_decode(encoded: str, offset: int) -> str:
    raw = base64.b64decode(encoded)
    offset_str = str(offset)
    return "".join(
        chr(b ^ ord(offset_str[i % len(offset_str)]))
        for i, b in enumerate(raw)
    )


def _make_session_token(header_token: str, challenge_text: str) -> str:
    """Combine the x-kahoot-session-token header with the challenge."""
    raw_header = base64.b64decode(header_token)
    challenge_result = _decode_challenge(challenge_text)
    return "".join(
        chr(a ^ ord(challenge_result[i % len(challenge_result)]))
        for i, a in enumerate(raw_header)
    )


# ---------------------------------------------------------------------------
# Kahoot Client
# ---------------------------------------------------------------------------
class KahootClient:
    """Connects to a live Kahoot game, receives questions and submits
    answers via the CometD protocol over WebSocket."""

    def __init__(self, pin: str, nickname: str):
        self.pin = str(pin).strip()
        self.nickname = nickname.strip()
        self.session_token: Optional[str] = None
        self.client_id: Optional[str] = None
        self.ws: Optional[websocket.WebSocketApp] = None
        self._msg_id = 0
        self._connected = False
        self._thread: Optional[threading.Thread] = None

        # Callbacks – set by the caller (e.g. the Flask server)
        self.on_question: Optional[Callable] = None   # (question_index, num_choices, question_text, time_limit)
        self.on_question_end: Optional[Callable] = None  # (correct_index, points)
        self.on_game_over: Optional[Callable] = None  # (rank, final_score)
        self.on_disconnect: Optional[Callable] = None  # (reason)
        self.on_status: Optional[Callable] = None      # (message)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def join(self) -> bool:
        """Reserve a session and connect to the game. Returns True on success."""
        self._emit_status("Verbinde mit Kahoot...")
        try:
            self.session_token = self._reserve_session()
        except Exception as exc:
            self._emit_status(f"Fehler: {exc}")
            return False

        self._emit_status("Session erhalten – öffne WebSocket...")
        self._connect_ws()
        return True

    def answer(self, choice: int) -> None:
        """Submit an answer choice (0-3)."""
        if not self._connected or self.ws is None:
            return
        payload = {
            "type": "message",
            "gamePingNum": 1,
            "content": json.dumps({
                "choice": choice,
                "meta": {"lag": 30, "device": {"userAgent": "kahoot-bot", "screen": {"width": 400, "height": 800}}},
            }),
        }
        self._send("/service/controller", payload)

    def leave(self) -> None:
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        self._connected = False

    # ------------------------------------------------------------------
    # Session reservation
    # ------------------------------------------------------------------
    def _reserve_session(self) -> str:
        url = f"{KAHOOT_BASE}/reserve/session/{self.pin}?{int(time.time() * 1000)}"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 404:
            raise RuntimeError(f"Spiel-PIN {self.pin} nicht gefunden")
        resp.raise_for_status()

        header_token = resp.headers.get("x-kahoot-session-token", "")
        if not header_token:
            raise RuntimeError("Kein Session-Token im Header")

        challenge = resp.json().get("challenge", "")
        if not challenge:
            raise RuntimeError("Keine Challenge in der Antwort")

        return _make_session_token(header_token, challenge)

    # ------------------------------------------------------------------
    # WebSocket / CometD
    # ------------------------------------------------------------------
    def _next_id(self) -> str:
        self._msg_id += 1
        return str(self._msg_id)

    def _connect_ws(self) -> None:
        ws_url = f"wss://kahoot.it/cometd/{self.pin}/{self.session_token}"
        self.ws = websocket.WebSocketApp(
            ws_url,
            on_open=self._on_ws_open,
            on_message=self._on_ws_message,
            on_error=self._on_ws_error,
            on_close=self._on_ws_close,
        )
        self._thread = threading.Thread(target=self.ws.run_forever, daemon=True)
        self._thread.start()

    def _send(self, channel: str, data: Optional[dict] = None) -> None:
        msg = {"channel": channel, "clientId": self.client_id, "id": self._next_id()}
        if data:
            msg["data"] = data
        if self.ws:
            self.ws.send(json.dumps([msg]))

    def _on_ws_open(self, ws):
        # CometD handshake
        handshake = [{
            "id": self._next_id(),
            "version": "1.0",
            "minimumVersion": "1.0",
            "channel": "/meta/handshake",
            "supportedConnectionTypes": ["websocket", "long-polling"],
            "advice": {"timeout": 60000, "interval": 0},
        }]
        ws.send(json.dumps(handshake))

    def _on_ws_message(self, ws, raw):
        try:
            messages = json.loads(raw)
        except json.JSONDecodeError:
            return

        for msg in messages:
            channel = msg.get("channel", "")

            if channel == "/meta/handshake":
                self._handle_handshake(msg)
            elif channel == "/meta/connect":
                self._handle_connect(msg)
            elif channel == "/service/player":
                self._handle_player_message(msg)
            elif channel == "/service/controller":
                self._handle_controller_message(msg)

    def _on_ws_error(self, ws, error):
        self._emit_status(f"WebSocket Fehler: {error}")

    def _on_ws_close(self, ws, close_status_code, close_msg):
        self._connected = False
        if self.on_disconnect:
            self.on_disconnect(close_msg or "Verbindung geschlossen")
        self._emit_status("Verbindung getrennt")

    def _handle_handshake(self, msg: dict) -> None:
        if not msg.get("successful"):
            self._emit_status("Handshake fehlgeschlagen")
            return
        self.client_id = msg.get("clientId")
        self._connected = True

        # Subscribe to channels
        for ch in ["/service/controller", "/service/player", "/service/status"]:
            sub = {
                "channel": "/meta/subscribe",
                "clientId": self.client_id,
                "id": self._next_id(),
                "subscription": ch,
            }
            self.ws.send(json.dumps([sub]))

        # Send connect (long-poll keepalive)
        self._send_connect()

        # Login
        self._login()

    def _send_connect(self) -> None:
        connect = {
            "channel": "/meta/connect",
            "clientId": self.client_id,
            "id": self._next_id(),
            "connectionType": "websocket",
        }
        if self.ws:
            self.ws.send(json.dumps([connect]))

    def _login(self) -> None:
        login_data = {
            "type": "login",
            "gameid": self.pin,
            "host": "kahoot.it",
            "name": self.nickname,
            "content": json.dumps({"device": {"userAgent": "kahoot-bot", "screen": {"width": 400, "height": 800}}}),
        }
        self._send("/service/controller", login_data)
        self._emit_status(f'Beigetreten als "{self.nickname}"!')

    def _handle_connect(self, msg: dict) -> None:
        # Keep the CometD connection alive
        if msg.get("successful"):
            time.sleep(0.5)
            threading.Thread(target=self._send_connect, daemon=True).start()

    def _handle_player_message(self, msg: dict) -> None:
        data = msg.get("data", {})
        msg_id = data.get("id")
        content_str = data.get("content", "{}")
        try:
            content = json.loads(content_str) if isinstance(content_str, str) else content_str
        except (json.JSONDecodeError, TypeError):
            content = {}

        if msg_id == 1:
            # Question start
            num_choices = content.get("numberOfChoices", 4)
            q_index = content.get("questionIndex", 0)
            time_limit = content.get("timeAvailable", 20000)
            q_text = content.get("questionText", "")
            self._emit_status(f"Frage {q_index + 1} – {num_choices} Antworten")
            if self.on_question:
                self.on_question(q_index, num_choices, q_text, time_limit)

        elif msg_id == 2:
            # Question ended / results
            correct = content.get("correctChoices", [])
            correct_idx = correct[0] if correct else None
            points = content.get("points", 0)
            if self.on_question_end:
                self.on_question_end(correct_idx, points)

        elif msg_id == 3:
            # Game over
            rank = content.get("rank", "?")
            score = content.get("totalScore", 0)
            self._emit_status(f"Spiel vorbei! Platz {rank}, Punkte: {score}")
            if self.on_game_over:
                self.on_game_over(rank, score)

    def _handle_controller_message(self, msg: dict) -> None:
        data = msg.get("data", {})
        if data.get("type") == "loginResponse":
            error = data.get("error")
            if error:
                self._emit_status(f"Login-Fehler: {error}")
            else:
                self._emit_status("Erfolgreich im Spiel!")

    def _emit_status(self, message: str) -> None:
        if self.on_status:
            self.on_status(message)
