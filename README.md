# Kahoot Bot – Auto-Solver Overlay

Ein Kahoot Auto-Solver der als **Overlay auf der echten Kahoot-Seite** läuft. Du spielst ganz normal auf kahoot.it – der Bot zeigt dir die richtige Antwort an und klickt sie automatisch.

## So funktioniert's

Der Bot startet einen lokalen Server der als Proxy für kahoot.it arbeitet. Du öffnest `localhost:8080` statt `kahoot.it` – die Seite sieht identisch aus, aber ein Overlay wird eingeblendet das die Antworten kennt.

## Schnellstart

### Auf dem PC

```bash
git clone https://github.com/D70notfound/Kahoot_bot.git
cd Kahoot_bot
pip install -r requirements.txt
python app.py
```

Öffne `http://localhost:8080` im Browser.

### Als Android APK

Die APK selbst bauen (braucht Linux/macOS + Java JDK):

```bash
git clone https://github.com/D70notfound/Kahoot_bot.git
cd Kahoot_bot
pip install buildozer cython
./build_apk.sh
```

Die fertige APK liegt dann in `bin/`. Auf dem Handy installieren und starten.

### Auf dem Handy (Alternative: Termux)

1. **Termux** aus dem F-Droid Store installieren
2. In Termux:

```bash
pkg update && pkg install python git
git clone https://github.com/D70notfound/Kahoot_bot.git
cd Kahoot_bot
pip install -r requirements.txt
python app.py
```

3. Öffne `http://localhost:8080` im Handy-Browser

## Benutzung

1. Starte den Bot mit `python app.py`
2. Öffne `http://localhost:8080` – du siehst die echte Kahoot-Seite
3. Tippe auf den **⚡ Button** unten rechts um das Overlay zu öffnen
4. **Quiz suchen**: Gib den Quiz-Titel ein damit der Bot die Antworten findet
5. **Auto-Antwort**: Aktiviert = Bot klickt automatisch. Deaktiviert = Antwort wird nur angezeigt
6. **Verzögerung**: Wie lange der Bot wartet bevor er klickt (0.1s - 3s)
7. Gib den Spiel-PIN auf der Kahoot-Seite ein und spiel los

## Features

- Echte Kahoot-Seite mit Overlay (kein separates Interface)
- Großer Antwort-Indikator in der Mitte (Farbe + Symbol)
- Automatisches Klicken der richtigen Antwort
- Quiz-Suche in der öffentlichen Kahoot-Datenbank
- Einstellbare Antwort-Verzögerung
- Live-Log aller Aktionen
- Punkte-Tracker

## Projektstruktur

```
Kahoot_bot/
├── app.py                 # Flask Reverse-Proxy + API
├── main.py                # Android APK Entry Point (Kivy + WebView)
├── buildozer.spec         # APK Build-Konfiguration
├── build_apk.sh           # Build-Script fuer die APK
├── requirements.txt       # Python-Abhängigkeiten
├── kahoot/
│   ├── client.py          # Standalone Kahoot-Client (Fallback)
│   └── solver.py          # Quiz-Suche und Antwort-Matching
└── static/
    ├── css/overlay.css    # Overlay-Styles
    └── js/overlay.js      # WebSocket-Interception + Overlay-UI
```

## Tipps

- **Quiz vorher suchen**: Gib den Quiz-Titel so genau wie möglich ein
- **Verzögerung anpassen**: Zu schnelle Antworten können auffallen (1-2s empfohlen)
- **Öffentliche Quizzes**: Funktioniert am besten mit öffentlich verfügbaren Quizzes
- **Private Quizzes**: Bei unbekannten Quizzes wird zufällig geantwortet
