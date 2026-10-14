package com.n5.minismanager

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.n5.minismanager.databinding.ActivityMainBinding
import kotlin.concurrent.thread

/** NovaOS itself, in a WebView — plus what a browser can't do on a phone or a TV. */
class MainActivity : AppCompatActivity() {
    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs
    private lateinit var base: String
    private var tv = false
    private var unlocked = false
    private var configFetched = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris = when {
            result.resultCode != RESULT_OK || data == null -> null
            data.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        base = prefs.serverUrl ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        tv = isTv()
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        applySystemBarInsets(b.root)

        val web = b.web
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            // NovaOS can tell it's inside the app (and on a TV) from the user agent.
            userAgentString = "$userAgentString MinisManagerApp/${BuildConfig.VERSION_NAME}" + if (tv) " (TV)" else " (Phone)"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "MinisApp")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ -> download(url, userAgent, contentDisposition, mimeType) }
        if (tv) {
            web.isFocusable = true
            web.isFocusableInTouchMode = true
        }

        // Pull to refresh on phones, only when the page is at its top.
        b.swipe.isEnabled = !tv
        b.swipe.setColorSchemeColors(ContextCompat.getColor(this, R.color.primary))
        b.swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
        b.swipe.setOnRefreshListener { web.reload() }

        b.retry.setOnClickListener { load() }
        b.errorSettings.setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        b.unlock.setOnClickListener { askUnlock() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> (b.web.webChromeClient as Chrome).onHideCustomView()
                    b.errorPanel.visibility == View.VISIBLE -> finish()
                    b.web.canGoBack() -> b.web.goBack()
                    else -> finish()
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else load(intent?.getStringExtra(EXTRA_URL))
        if (prefs.notifications) NotifyService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_URL)?.let { load(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        b.web.saveState(outState)
    }

    override fun onStart() {
        super.onStart()
        val away = System.currentTimeMillis() - prefs.backgroundAt
        if (prefs.biometric && (!unlocked || away > LOCK_AFTER_MS)) lock()
    }

    override fun onStop() {
        super.onStop()
        prefs.backgroundAt = System.currentTimeMillis()
        CookieManager.getInstance().flush()
    }

    private fun load(url: String? = null) {
        b.errorPanel.visibility = View.GONE
        val target = url?.takeIf { sameServer(Uri.parse(it)) } ?: base
        b.web.loadUrl(target)
    }

    private fun sameServer(u: Uri): Boolean {
        val s = Uri.parse(base)
        return u.host == s.host && (if (u.port == -1) 443 else u.port) == (if (s.port == -1) 443 else s.port)
    }

    // ---- the fingerprint lock ----
    private fun lock() {
        unlocked = false
        b.lockPanel.visibility = View.VISIBLE
        b.unlock.requestFocus()
        askUnlock()
    }

    private fun askUnlock() {
        val ok = BiometricManager.from(this).canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS
        if (!ok) return unlock() // nothing to unlock with anymore: don't lock the user out
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = unlock()
        }).authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.lock_title))
                .setSubtitle(getString(R.string.lock_subtitle))
                .setAllowedAuthenticators(AUTH)
                .build(),
        )
    }

    private fun unlock() {
        unlocked = true
        b.lockPanel.visibility = View.GONE
        b.web.requestFocus()
    }

    // ---- downloads from the page (Files → Download) ----
    private fun download(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        if (!url.startsWith("http")) return
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val req = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(name)
            setMimeType(mimeType)
            CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
            addRequestHeader("User-Agent", userAgent)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        }
        (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
        Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
    }

    /** After sign-in: the server's notification settings (ntfy), so the service can connect. */
    private fun fetchAppConfig() {
        if (configFetched || !prefs.notifications) return
        configFetched = true
        thread {
            runCatching {
                val (code, j) = Server.call(base, "GET", "/api/app/config")
                if (code == 200 && j != null) {
                    j.optJSONObject("ntfy")?.let { n ->
                        prefs.ntfyUrl = n.optString("url")
                        prefs.ntfyTopic = n.optString("topic")
                        prefs.ntfyToken = n.optString("token")
                        NotifyService.start(this)
                    }
                } else {
                    configFetched = false // not signed in yet: try again after the next page load
                }
            }.onFailure { configFetched = false }
        }
    }

    /** Links to other apps on the server open in their own app when it's installed (Jellyfin, Moonlight…). */
    private fun openOutside(u: Uri): Boolean {
        val s = Uri.parse(base)
        if (u.host == s.host && (u.port == 20017 || u.port == 8096)) {
            val pkg = if (tv) "org.jellyfin.androidtv" else "org.jellyfin.mobile"
            packageManager.getLaunchIntentForPackage(pkg)?.let { startActivity(it); return true }
        }
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
            true
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show()
            true
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            if (u.scheme == "https" && sameServer(u)) return false
            if (u.scheme == "magnet") {
                startActivity(Intent(this@MainActivity, ShareActivity::class.java).setAction(Intent.ACTION_VIEW).setData(u))
                return true
            }
            return openOutside(u)
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            b.loading.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String?) {
            b.loading.visibility = View.GONE
            b.swipe.isRefreshing = false
            if (tv) {
                // The page's focus ring (and the remote's OK) need the WebView itself to hold Android focus.
                view.requestFocus()
                injectTvNavigation(view)
            } else {
                injectRefreshHold(view)
            }
            fetchAppConfig()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            b.swipe.isRefreshing = false
            b.loading.visibility = View.GONE
            b.errorBody.text = "${getString(R.string.error_body)}\n\n(${error.description})"
            b.errorPanel.visibility = View.VISIBLE
            b.retry.requestFocus()
        }
    }

    /**
     * TV remote: arrow keys move between buttons and links (W3C spatial navigation), with a clear
     * focus ring; OK presses the focused one.
     */
    private fun injectTvNavigation(view: WebView) {
        val polyfill = assets.open("spatial-navigation-polyfill.js").bufferedReader().readText()
        val css = """
            :focus { outline: 3px solid #2F6FE4 !important; outline-offset: 3px !important; border-radius: 12px; }
            :focus:not(input):not(textarea) { box-shadow: 0 0 0 6px rgba(47,111,228,.25) !important; }
        """.trimIndent().replace("\n", " ")
        view.evaluateJavascript(
            """
            (function(){
              if (window.__mmTv) return; window.__mmTv = true;
              var s = document.createElement('style'); s.textContent = ${org.json.JSONObject.quote(css)}; document.head.appendChild(s);
              $polyfill
              // TV: landing on a text field with the arrows must not pop the keyboard (it would take
              // the arrows). Fields stay read-only until OK is pressed on them, and again when left.
              var TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]), textarea';
              function guard(el){ if (!el.__mmGuard) { el.__mmGuard = true; if (!el.readOnly) { el.readOnly = true; el.__mmRo = true; } el.addEventListener('blur', function(){ if (el.__mmEditable) { el.__mmEditable = false; el.readOnly = true; el.__mmRo = true; } }); } }
              document.querySelectorAll(TEXT).forEach(guard);
              new MutationObserver(function(){ document.querySelectorAll(TEXT).forEach(guard); }).observe(document.body, { childList: true, subtree: true });
              window.__mmOk = function(){
                var el = document.activeElement;
                if (!el || el === document.body) return;
                if (el.__mmRo && !el.__mmEditable) {
                  // blur before marking it editable: the blur handler re-locks only editable fields
                  el.readOnly = false; el.__mmRo = false;
                  el.blur(); el.__mmEditable = true; el.focus();
                  window.MinisApp && window.MinisApp.showKeyboard && window.MinisApp.showKeyboard();
                } else if (el.__mmEditable) {
                  window.MinisApp && window.MinisApp.showKeyboard && window.MinisApp.showKeyboard();
                } else {
                  el.click();
                }
              };
              document.addEventListener('keydown', function(e){
                var el = document.activeElement;
                if (e.key === 'Enter' && el && el.__mmRo && !el.__mmEditable) {
                  e.preventDefault(); e.stopPropagation();
                  el.readOnly = false; el.__mmRo = false;
                  el.blur(); el.__mmEditable = true; el.focus();
                  window.MinisApp && window.MinisApp.showKeyboard && window.MinisApp.showKeyboard();
                }
              }, true);
              if (!document.activeElement || document.activeElement === document.body) {
                var first = Array.prototype.find.call(document.querySelectorAll('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])'), function(el){ return el.offsetParent !== null && !el.disabled; }); if (first) first.focus();
              }
            })();
            """.trimIndent(),
            null,
        )
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            b.loading.setProgressCompat(newProgress, true)
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val types = params.acceptTypes.filter { it.isNotBlank() }
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = types.singleOrNull()?.takeIf { it.contains('/') } ?: "*/*"
                if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.filter { it.contains('/') }.toTypedArray())
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            }
            return try {
                pickFiles.launch(Intent.createChooser(intent, null))
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            customView = view
            customViewCallback = callback
            b.fullscreen.addView(view)
            b.fullscreen.visibility = View.VISIBLE
            WindowInsetsControllerCompat(window, b.root).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        override fun onHideCustomView() {
            b.fullscreen.removeAllViews()
            b.fullscreen.visibility = View.GONE
            customView = null
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            WindowInsetsControllerCompat(window, b.root).show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** While a finger is inside a row that scrolls sideways, pull-to-refresh stays off. */
    private fun injectRefreshHold(view: WebView) {
        view.evaluateJavascript(
            """
            (function(){
              if (window.__mmHold) return; window.__mmHold = true;
              function scrollsX(el){ while (el && el !== document.body) { var s = getComputedStyle(el);
                if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4) return true; el = el.parentElement; } return false; }
              document.addEventListener('touchstart', function(e){ MinisApp.holdRefresh(scrollsX(e.target) || window.scrollY > 0); }, { passive: true, capture: true });
              document.addEventListener('touchend', function(){ MinisApp.holdRefresh(false); }, { passive: true, capture: true });
              document.addEventListener('touchcancel', function(){ MinisApp.holdRefresh(false); }, { passive: true, capture: true });
            })();
            """.trimIndent(),
            null,
        )
    }

    /** window.MinisApp in the page. */
    private inner class Bridge {
        @JavascriptInterface fun holdRefresh(on: Boolean) { b.swipe.held = on }
        @JavascriptInterface fun openSettings() = runOnUiThread { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) }
        @JavascriptInterface fun isTv() = tv
        @JavascriptInterface fun version() = BuildConfig.VERSION_NAME
        @JavascriptInterface fun showKeyboard() = runOnUiThread {
            (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showSoftInput(b.web, 0)
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // TV remote OK: handled by the page script (opens the keyboard on a text field, presses anything else).
        if (tv && b.web.hasFocus() && b.lockPanel.visibility != View.VISIBLE &&
            (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || event.keyCode == KeyEvent.KEYCODE_ENTER && !keyboardOpen())
        ) {
            if (event.action == KeyEvent.ACTION_UP) b.web.evaluateJavascript("window.__mmOk && window.__mmOk()", null)
            return true
        }
        // TV remotes' MENU button opens App settings.
        if (event.keyCode == KeyEvent.KEYCODE_MENU && event.action == KeyEvent.ACTION_UP) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun keyboardOpen(): Boolean =
        androidx.core.view.ViewCompat.getRootWindowInsets(b.root)?.isVisible(WindowInsetsCompat.Type.ime()) == true

    companion object {
        const val EXTRA_URL = "url"
        private const val LOCK_AFTER_MS = 60_000L
        private val AUTH = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }

}
