package com.n5.minismanager

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Setup on the first run, the app afterwards. */
class LaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val next = if (Prefs(this).serverUrl == null) SetupActivity::class.java else MainActivity::class.java
        startActivity(Intent(this, next).apply { intent?.data?.let { data = it } })
        finish()
    }
}
