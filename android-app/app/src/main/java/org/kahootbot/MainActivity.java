package org.kahootbot;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.view.View;
import android.webkit.*;
import androidx.appcompat.app.AppCompatActivity;
import java.io.*;

/**
 * Kahoot Bot - Android App
 * Loads kahoot.it in a WebView and injects the overlay JS/CSS
 * for auto-solving quizzes. No backend server needed.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private String overlayCSS = "";
    private String overlayJS = "";
    private String solverJS = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Load overlay assets
        overlayCSS = loadAsset("bot/overlay.css");
        overlayJS = loadAsset("bot/overlay.js");
        solverJS = loadAsset("bot/solver.js");

        // Create WebView
        webView = new WebView(this);
        setContentView(webView);

        // Full screen
        webView.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );

        // Configure WebView settings
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        );
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        // Custom WebViewClient to inject overlay on page load
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Only inject on kahoot.it pages
                if (url != null && url.contains("kahoot.it")) {
                    injectOverlay(view);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Keep kahoot.it navigation in WebView
                if (url.contains("kahoot.it") || url.contains("kahoot.com")) {
                    return false;
                }
                return false;
            }
        });

        // Custom WebChromeClient for console.log
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                return true;
            }
        });

        // Load Kahoot
        webView.loadUrl("https://kahoot.it");
    }

    /**
     * Inject the overlay CSS, solver JS, and overlay JS into the page.
     */
    private void injectOverlay(WebView view) {
        // Inject CSS
        if (!overlayCSS.isEmpty()) {
            String cssInjection = "(function(){" +
                "var s=document.createElement('style');" +
                "s.textContent=" + escapeJS(overlayCSS) + ";" +
                "document.head.appendChild(s);" +
                "})();";
            view.evaluateJavascript(cssInjection, null);
        }

        // Inject solver (quiz search + answer matching, replaces Python backend)
        if (!solverJS.isEmpty()) {
            view.evaluateJavascript(solverJS, null);
        }

        // Inject overlay UI + logic
        if (!overlayJS.isEmpty()) {
            view.evaluateJavascript(overlayJS, null);
        }
    }

    /**
     * Load a text file from assets.
     */
    private String loadAsset(String path) {
        try (InputStream is = getAssets().open(path);
             BufferedReader reader = new BufferedReader(new InputStreamReader(is))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (IOException e) {
            return "";
        }
    }

    /**
     * Escape a string for safe injection into JavaScript.
     */
    private String escapeJS(String s) {
        return "'" + s
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
            + "'";
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
