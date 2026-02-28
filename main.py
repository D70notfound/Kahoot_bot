"""Kahoot Bot – Android APK Entry Point
Starts the Flask backend server in a background thread and shows
the web UI in an Android WebView (or system browser on desktop)."""

import os
import sys
import threading
import time

# Ensure project root is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.label import Label
from kivy.clock import Clock
from kivy.core.window import Window
from kivy.utils import platform

# Server config
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8080
SERVER_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"


def start_flask_server():
    """Start the Flask reverse-proxy server in a background thread."""
    from app import app
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, use_reloader=False)


class KahootBotApp(App):
    title = "Kahoot Bot"

    def build(self):
        Window.clearcolor = (0.086, 0.129, 0.243, 1)  # #16213e

        self.layout = BoxLayout(orientation="vertical", padding=20, spacing=10)

        self.status_label = Label(
            text="[b]Kahoot Auto-Solver[/b]\n\nServer wird gestartet...",
            markup=True,
            halign="center",
            valign="middle",
            font_size="18sp",
            color=(0.93, 0.93, 0.93, 1),
        )
        self.status_label.bind(size=self.status_label.setter("text_size"))
        self.layout.add_widget(self.status_label)

        # Start the Flask server in the background
        self.server_thread = threading.Thread(target=start_flask_server, daemon=True)
        self.server_thread.start()

        # Wait a moment, then open the WebView
        Clock.schedule_once(self._open_webview, 2.0)

        return self.layout

    def _open_webview(self, dt):
        """Open the bot UI – uses Android WebView or system browser."""
        if platform == "android":
            self._open_android_webview()
        else:
            # Desktop fallback – open in system browser
            import webbrowser
            webbrowser.open(SERVER_URL)
            self.status_label.text = (
                "[b]Kahoot Auto-Solver[/b]\n\n"
                f"Server laeuft auf:\n{SERVER_URL}\n\n"
                "Im Browser geoeffnet!"
            )

    def _open_android_webview(self):
        """Replace the Kivy view with an Android WebView."""
        try:
            from jnius import autoclass, cast
            from android.runnable import run_on_ui_thread

            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            WebView = autoclass("android.webkit.WebView")
            WebViewClient = autoclass("android.webkit.WebViewClient")
            WebSettings = autoclass("android.webkit.WebSettings")
            LinearLayout = autoclass("android.widget.LinearLayout")
            LayoutParams = autoclass("android.widget.LinearLayout$LayoutParams")
            View = autoclass("android.view.View")

            activity = PythonActivity.mActivity

            @run_on_ui_thread
            def setup_webview():
                webview = WebView(activity)
                settings = webview.getSettings()
                settings.setJavaScriptEnabled(True)
                settings.setDomStorageEnabled(True)
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW)
                settings.setUserAgentString(
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                )

                webview.setWebViewClient(WebViewClient())
                webview.loadUrl(SERVER_URL)

                layout = LinearLayout(activity)
                layout.setOrientation(LinearLayout.VERTICAL)
                params = LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
                )
                layout.addView(webview, params)

                activity.setContentView(layout)

            setup_webview()

        except Exception as e:
            self.status_label.text = (
                "[b]Kahoot Auto-Solver[/b]\n\n"
                f"Server laeuft auf:\n{SERVER_URL}\n\n"
                "Oeffne die URL im Browser!\n\n"
                f"(WebView-Fehler: {e})"
            )

    def on_pause(self):
        return True

    def on_resume(self):
        pass


if __name__ == "__main__":
    KahootBotApp().run()
