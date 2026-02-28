[app]

# App metadata
title = Kahoot Bot
package.name = kahootbot
package.domain = org.kahootbot
version = 1.0.0

# Source
source.dir = .
source.include_exts = py,png,jpg,kv,atlas,js,css,html

# Requirements – Python packages needed in the APK
requirements = python3,kivy,flask,requests,websocket-client,pyjnius,android,certifi,urllib3,charset-normalizer,idna,werkzeug,jinja2,markupsafe,itsdangerous,click,blinker

# Android settings
android.permissions = INTERNET,ACCESS_NETWORK_STATE
android.api = 33
android.minapi = 21
android.ndk = 25b
android.accept_sdk_license = True
android.arch = arm64-v8a

# App appearance
orientation = portrait
fullscreen = 0

# Icon (uses default if not present)
# icon.filename = %(source.dir)s/icon.png

# Presplash
# presplash.filename = %(source.dir)s/presplash.png
presplash.color = #16213e

# Android-specific
android.allow_backup = True
android.wakelock = False

# Release / Debug
# For release builds, set p4a.branch and sign the APK
# android.release_artifact = apk

# Include the kahoot package and static files
source.include_patterns = app.py,main.py,kahoot/*.py,static/css/*.css,static/js/*.js

# Log level
log_level = 2

# Build
# p4a.branch = master

[buildozer]
log_level = 2
warn_on_root = 1
