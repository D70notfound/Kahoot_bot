#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Kahoot Bot – APK Build Script
# Baut die Android APK mit Buildozer
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     Kahoot Bot – APK Builder         ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Check for buildozer
if ! command -v buildozer &> /dev/null; then
    echo "[*] Buildozer nicht gefunden. Installiere..."
    pip install buildozer cython
fi

# Check for Java
if ! command -v java &> /dev/null; then
    echo "[!] Java JDK wird benoetigt!"
    echo "    Ubuntu/Debian: sudo apt install openjdk-17-jdk"
    echo "    macOS: brew install openjdk@17"
    exit 1
fi

# Install system dependencies (Ubuntu/Debian)
if command -v apt &> /dev/null; then
    echo "[*] Installiere System-Abhaengigkeiten..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        python3-pip \
        build-essential \
        git \
        zip \
        unzip \
        autoconf \
        libtool \
        pkg-config \
        zlib1g-dev \
        libncurses5-dev \
        libncursesw5-dev \
        libtinfo5 \
        cmake \
        libffi-dev \
        libssl-dev \
        2>/dev/null || true
fi

echo ""
echo "[*] Starte APK-Build..."
echo "[*] Das kann beim ersten Mal 10-30 Minuten dauern"
echo "    (Android SDK/NDK werden automatisch heruntergeladen)"
echo ""

# Build debug APK
buildozer android debug

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     APK erfolgreich gebaut!          ║"
echo "  ╠══════════════════════════════════════╣"
echo "  ║  Datei: bin/*.apk                    ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Show APK location
APK_FILE=$(ls -1 bin/*.apk 2>/dev/null | head -1)
if [ -n "$APK_FILE" ]; then
    echo "APK: $APK_FILE"
    echo "Groesse: $(du -h "$APK_FILE" | cut -f1)"
    echo ""
    echo "Installieren mit: adb install $APK_FILE"
    echo "Oder die APK-Datei auf dein Handy kopieren."
fi
