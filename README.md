# Kahoot Bot – Auto-Solver

Ein Kahoot Auto-Solver Bot mit mobiler Web-Oberfläche. Tritt automatisch Kahoot-Spielen bei, sucht Antworten und antwortet blitzschnell.

## Features

- Mobile-freundliche Web-Oberfläche (Dark Mode)
- Automatisches Beitreten per Spiel-PIN
- Quiz-Suche in der öffentlichen Kahoot-Datenbank
- Auto-Antwort mit Fallback auf Zufallsantworten
- Echtzeit-Updates per WebSocket
- Timer und Punkte-Anzeige

## Schnellstart

### Auf dem PC

```bash
# Repository klonen
git clone https://github.com/D70notfound/Kahoot_bot.git
cd Kahoot_bot

# Abhängigkeiten installieren
pip install -r requirements.txt

# Bot starten
python app.py
```

Öffne dann `http://localhost:8080` im Browser (oder auf dem Handy im selben WLAN).

### Auf dem Handy (Android mit Termux)

1. **Termux** aus dem F-Droid Store installieren
2. In Termux:

```bash
# Python installieren
pkg update && pkg install python git

# Repository klonen
git clone https://github.com/D70notfound/Kahoot_bot.git
cd Kahoot_bot

# Abhängigkeiten installieren
pip install -r requirements.txt

# Bot starten
python app.py
```

3. Öffne `http://localhost:8080` im Handy-Browser

## Benutzung

1. **Spiel-PIN eingeben** – Den PIN vom Kahoot-Bildschirm
2. **Nickname** – Optional, sonst wird ein zufälliger Name generiert
3. **Quiz suchen** – Unter "Erweiterte Optionen" kannst du nach dem Quiz-Titel suchen, damit der Bot die richtigen Antworten findet
4. **Auto-Antwort** – Aktiviert: Bot antwortet automatisch. Deaktiviert: Du siehst die vorgeschlagene Antwort und klickst selbst

## Projektstruktur

```
Kahoot_bot/
├── app.py                 # Flask Web-Server mit Socket.IO
├── requirements.txt       # Python-Abhängigkeiten
├── kahoot/
│   ├── client.py          # Kahoot WebSocket/CometD Client
│   └── solver.py          # Quiz-Suche und Antwort-Finder
├── templates/
│   └── index.html         # Web-Oberfläche
└── static/
    ├── css/style.css      # Mobile-first Styling
    └── js/app.js          # Frontend-Logik
```

## Hinweise

- Der Bot funktioniert am besten, wenn das Quiz öffentlich verfügbar ist
- Bei privaten Quizzes wird auf Zufallsantworten zurückgegriffen
- Für die Quiz-Suche den Titel so genau wie möglich eingeben
- Der Bot muss im selben Netzwerk wie der Browser laufen (für Handy-Zugriff)
