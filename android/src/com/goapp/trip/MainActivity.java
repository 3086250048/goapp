package com.goapp.trip;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.net.URI;
import java.net.URISyntaxException;

public class MainActivity extends Activity {
    private static final int ORANGE = Color.rgb(255, 107, 44);

    private WebView webView;
    private TextView loadingView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        loadingView = new TextView(this);
        loadingView.setText("正在加载出行服务…");
        loadingView.setTextColor(Color.rgb(100, 106, 115));
        loadingView.setTextSize(14);
        loadingView.setGravity(Gravity.CENTER);
        loadingView.setBackgroundColor(Color.WHITE);
        root.addView(loadingView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();
        webView.loadUrl(AppConfig.START_URL);
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    @SuppressWarnings("deprecation")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " GoappAndroid/2.3.0");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openUrl(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadingView.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOfflinePage();
                }
            }
        });
    }

    private boolean openUrl(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // Ignore unsupported custom schemes.
            }
            return true;
        }
        if (isOAuthHost(uri.getHost())) {
            return false;
        }
        if (sameHost(url, AppConfig.START_URL)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // Keep the app responsive if no browser is installed.
        }
        return true;
    }

    private boolean isOAuthHost(String host) {
        if (host == null) return false;
        String normalized = host.toLowerCase();
        return normalized.endsWith(".weixin.qq.com")
                || normalized.equals("graph.qq.com")
                || normalized.endsWith(".ptlogin2.qq.com");
    }

    private boolean sameHost(String first, String second) {
        try {
            String firstHost = new URI(first).getHost();
            String secondHost = new URI(second).getHost();
            return firstHost != null && firstHost.equalsIgnoreCase(secondHost);
        } catch (URISyntaxException ignored) {
            return false;
        }
    }

    private void showOfflinePage() {
        loadingView.setVisibility(View.GONE);
        String retryUrl = AppConfig.START_URL.replace("\"", "%22");
        String html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
                + "font-family:sans-serif;background:#f5f6f8;color:#1f2329}"
                + "main{text-align:center;padding:32px}i{font-style:normal;font-size:52px}"
                + "h1{font-size:20px;margin:18px 0 10px}p{font-size:13px;line-height:1.7;color:#646a73}"
                + "a{display:inline-flex;align-items:center;justify-content:center;margin-top:20px;"
                + "width:160px;height:46px;border-radius:23px;background:#ff6b2c;color:#fff;"
                + "text-decoration:none;font-weight:600}</style></head><body><main><i>📡</i>"
                + "<h1>暂时连不上服务</h1><p>请检查网络后重试。<br>如果是短暂断网，已加载的凭证可以继续查看。</p>"
                + "<a href=\"" + retryUrl + "\">重新加载</a></main></body></html>";
        webView.loadDataWithBaseURL(AppConfig.START_URL, html, "text/html", "utf-8", null);
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
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
