#!/usr/bin/env python3
"""Kahoot Auto-Solver – Reverse proxy that serves the real kahoot.it
with an overlay injected for answer suggestions and auto-answering."""

import re

from flask import Flask, Response, request, jsonify, send_from_directory
import requests as http

from kahoot.solver import QuizSolver

app = Flask(__name__)

TARGET = "https://kahoot.it"
solver = QuizSolver()

# Headers that should not be forwarded between proxy hops
EXCLUDED_REQUEST_HEADERS = {
    "host", "connection", "accept-encoding",
}
EXCLUDED_RESPONSE_HEADERS = {
    "connection", "keep-alive", "transfer-encoding", "content-encoding",
    "content-length", "x-frame-options", "content-security-policy",
    "content-security-policy-report-only", "strict-transport-security",
}

# ─── Bot API ──────────────────────────────────────────────────────────
@app.route("/_bot/api/search", methods=["POST"])
def api_search():
    """Search for a quiz and load its answers."""
    data = request.get_json(silent=True) or {}
    query = data.get("query", "").strip()
    quiz_id = data.get("quiz_id", "").strip()

    if quiz_id:
        ok = solver.load_quiz_by_id(quiz_id)
    elif query:
        ok = solver.load_quiz_by_search(query)
    else:
        return jsonify({"success": False, "error": "Kein Suchbegriff angegeben"})

    if ok:
        return jsonify({
            "success": True,
            "count": len(solver.quiz_answers),
            "questions": solver.get_loaded_questions(),
        })
    return jsonify({"success": False, "error": "Kein Quiz gefunden"})


@app.route("/_bot/api/answer", methods=["POST"])
def api_answer():
    """Get the suggested answer for a specific question index."""
    data = request.get_json(silent=True) or {}
    idx = data.get("index", 0)
    text = data.get("text", "")
    num = data.get("num_choices", 4)
    answer = solver.find_answer(idx, text, num)
    return jsonify({"answer": answer})


@app.route("/_bot/static/<path:filename>")
def bot_static(filename):
    """Serve overlay static files."""
    return send_from_directory("static", filename)


# ─── Reverse Proxy ────────────────────────────────────────────────────
@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
def proxy(path):
    """Proxy all requests to kahoot.it, injecting the overlay into HTML."""
    # Don't proxy our own bot routes
    if path.startswith("_bot/"):
        return Response("Not Found", status=404)

    url = f"{TARGET}/{path}"
    if request.query_string:
        url += f"?{request.query_string.decode()}"

    # Forward request headers
    headers = {}
    for key, value in request.headers:
        if key.lower() not in EXCLUDED_REQUEST_HEADERS:
            headers[key] = value
    headers["Host"] = "kahoot.it"
    headers["Referer"] = url
    headers["Origin"] = TARGET

    try:
        resp = http.request(
            method=request.method,
            url=url,
            headers=headers,
            data=request.get_data(),
            cookies=request.cookies,
            allow_redirects=False,
            timeout=15,
        )
    except http.RequestException as exc:
        return Response(f"Proxy error: {exc}", status=502)

    content = resp.content
    content_type = resp.headers.get("Content-Type", "")

    # Inject overlay into HTML pages
    if "text/html" in content_type:
        content = _inject_overlay(content)

    # Rewrite redirect Location headers to point to our proxy
    response_headers = []
    for key, value in resp.headers.items():
        if key.lower() in EXCLUDED_RESPONSE_HEADERS:
            continue
        if key.lower() == "location":
            value = _rewrite_location(value)
        response_headers.append((key, value))

    return Response(content, status=resp.status_code, headers=response_headers,
                    content_type=content_type)


def _inject_overlay(html_bytes: bytes) -> bytes:
    """Inject the overlay script and stylesheet into the HTML page."""
    html = html_bytes.decode("utf-8", errors="replace")

    injection = (
        '<link rel="stylesheet" href="/_bot/static/css/overlay.css">'
        '<script src="/_bot/static/js/overlay.js"></script>'
    )

    # Inject right before </head> (or </body> as fallback)
    if "</head>" in html:
        html = html.replace("</head>", injection + "</head>", 1)
    elif "</body>" in html:
        html = html.replace("</body>", injection + "</body>", 1)
    else:
        html += injection

    return html.encode("utf-8")


def _rewrite_location(url: str) -> str:
    """Rewrite absolute kahoot.it URLs in redirects to our proxy."""
    url = re.sub(r"https?://kahoot\.it", "", url)
    return url


# ─── Entry Point ──────────────────────────────────────────────────────
if __name__ == "__main__":
    print()
    print("  ╔══════════════════════════════════════╗")
    print("  ║     Kahoot Auto-Solver Bot           ║")
    print("  ║     Overlay-Modus                    ║")
    print("  ╠══════════════════════════════════════╣")
    print("  ║  Öffne im Browser:                   ║")
    print("  ║  → http://localhost:8080              ║")
    print("  ╚══════════════════════════════════════╝")
    print()
    app.run(host="0.0.0.0", port=8080, debug=False)
