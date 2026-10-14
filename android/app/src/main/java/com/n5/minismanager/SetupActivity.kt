package com.n5.minismanager

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.core.content.ContextCompat
import com.n5.minismanager.databinding.ActivitySetupBinding
import kotlin.concurrent.thread

/** First run (and "Change server"): find the server, then choose notifications and the lock. */
class SetupActivity : AppCompatActivity() {
    private lateinit var b: ActivitySetupBinding
    private lateinit var prefs: Prefs
    private var found: Server.Found? = null

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) b.notifications.isChecked = false
        done()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(b.root)
        applySystemBarInsets(b.root)
        limitCardWidth(b.root)
        prefs = Prefs(this)

        // Pre-fill: the current server when changing it, else nothing (the hint shows the shape).
        prefs.serverUrl?.let { url ->
            val u = java.net.URL(url)
            b.address.setText(u.host)
            b.port.setText(u.port.takeIf { it != -1 }?.toString() ?: "7443")
        }
        b.connect.setOnClickListener { connect() }
        b.port.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_DONE) connect().let { true } else false }
        b.back.setOnClickListener { showConnect() }
        b.finish.setOnClickListener { finishSetup() }

        // TV: no background notifications (and usually no fingerprint reader).
        if (isTv()) {
            b.notifications.isChecked = false
            b.notifications.visibility = View.GONE
            b.notificationsSummary.visibility = View.GONE
        }
        val canBio = BiometricManager.from(this).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL,
        ) == BiometricManager.BIOMETRIC_SUCCESS
        if (!canBio) {
            b.biometric.visibility = View.GONE
            b.biometricSummary.visibility = View.GONE
        }
        b.address.requestFocus()
    }

    private fun connect() {
        val address = b.address.text?.toString().orEmpty()
        val port = b.port.text?.toString().orEmpty()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(b.root.windowToken, 0)
        b.status.visibility = View.GONE
        b.progress.visibility = View.VISIBLE
        b.connect.isEnabled = false
        b.connect.setText(R.string.setup_connecting)
        thread {
            val result = runCatching { Server.probe(address, port) }
            runOnUiThread {
                b.progress.visibility = View.GONE
                b.connect.isEnabled = true
                b.connect.setText(R.string.setup_connect)
                result.onSuccess { f ->
                    found = f
                    val host = java.net.URL(f.url).host
                    b.found.text = if (f.viaName != null) getString(R.string.setup_found_via, host, f.viaName) else getString(R.string.setup_found, host)
                    b.connectPanel.visibility = View.GONE
                    b.prefsPanel.visibility = View.VISIBLE
                    b.biometric.isChecked = prefs.biometric
                    b.finish.requestFocus()
                }.onFailure { e ->
                    b.status.visibility = View.VISIBLE
                    b.status.setTextColor(ContextCompat.getColor(this, R.color.danger))
                    b.status.text = friendly(e)
                    b.address.requestFocus()
                }
            }
        }
    }

    private fun friendly(e: Throwable): String = when (e) {
        is java.net.UnknownHostException -> "Couldn't find that address. Is Tailscale on?"
        is java.net.SocketTimeoutException, is java.net.ConnectException -> "No answer from the server. Check Tailscale and the port."
        is javax.net.ssl.SSLException -> "The secure connection failed. Check the address and that Tailscale is on."
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun showConnect() {
        b.prefsPanel.visibility = View.GONE
        b.connectPanel.visibility = View.VISIBLE
        b.address.requestFocus()
    }

    private fun finishSetup() {
        val wantsNotifications = b.notifications.isChecked && !isTv()
        if (wantsNotifications && Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            done()
        }
    }

    private fun done() {
        val f = found ?: return
        val changed = prefs.serverUrl != f.url
        prefs.serverUrl = f.url
        prefs.notifications = b.notifications.isChecked && !isTv()
        prefs.biometric = b.biometric.isChecked
        if (changed) {
            prefs.ntfyUrl = null
            prefs.ntfyTopic = null
            prefs.ntfyToken = null
            prefs.ntfySince = null
        }
        // The notification service starts once NovaOS is signed in (it needs the session for its settings).
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
