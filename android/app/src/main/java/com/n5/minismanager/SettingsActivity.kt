package com.n5.minismanager

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.core.content.ContextCompat
import com.n5.minismanager.databinding.ActivitySettingsBinding
import kotlin.concurrent.thread

/** App settings: server, notifications, fingerprint lock, version. NovaOS's own settings stay in the web app. */
class SettingsActivity : AppCompatActivity() {
    private lateinit var b: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        setNotifications(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(b.root)
        applySystemBarInsets(b.root)
        limitCardWidth(b.root)
        prefs = Prefs(this)

        b.toolbar.setNavigationOnClickListener { finish() }
        b.server.text = prefs.serverUrl?.removePrefix("https://") ?: "—"
        b.version.text = getString(R.string.pref_version, BuildConfig.VERSION_NAME) + if (isTv()) " · Android TV" else ""
        b.changeServer.setOnClickListener { startActivity(Intent(this, SetupActivity::class.java)) }
        b.reload.setOnClickListener {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(MainActivity.EXTRA_URL, prefs.serverUrl))
            finish()
        }

        if (isTv()) {
            b.notificationsGroup.visibility = View.GONE
        } else {
            b.notifications.isChecked = prefs.notifications
            b.notifications.setOnCheckedChangeListener { _, on ->
                if (on && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    setNotifications(on)
                }
            }
            b.test.setOnClickListener { test() }
            b.battery.setOnClickListener { askBattery() }
        }

        val canBio = BiometricManager.from(this).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL,
        ) == BiometricManager.BIOMETRIC_SUCCESS
        if (!canBio) b.biometricGroup.visibility = View.GONE
        b.biometric.isChecked = prefs.biometric
        b.biometric.setOnCheckedChangeListener { _, on -> prefs.biometric = on }
        b.changeServer.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        b.test.isEnabled = prefs.notifications && !prefs.ntfyUrl.isNullOrBlank()
        b.battery.visibility = if (batteryOptimised()) View.VISIBLE else View.GONE
    }

    private fun setNotifications(on: Boolean) {
        b.notifications.isChecked = on
        prefs.notifications = on
        if (on) {
            NotifyService.start(this)
            if (prefs.ntfyUrl.isNullOrBlank()) Toast.makeText(this, "Open NovaOS once while signed in to finish connecting.", Toast.LENGTH_LONG).show()
        } else {
            NotifyService.stop(this)
        }
        b.test.isEnabled = on && !prefs.ntfyUrl.isNullOrBlank()
    }

    private fun test() {
        b.test.isEnabled = false
        thread {
            val err = NotifyService.sendTest(this)
            runOnUiThread {
                b.test.isEnabled = true
                Toast.makeText(this, if (err == null) getString(R.string.test_sent) else getString(R.string.test_failed, err), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun batteryOptimised(): Boolean =
        !isTv() && prefs.notifications && !(getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife")
    private fun askBattery() {
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
    }
}
