package com.n5.minismanager

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.app.UiModeManager

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_ALERTS, getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHANNEL_UPDATES, getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT),
                NotificationChannel(CHANNEL_SERVICE, getString(R.string.channel_service), NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                },
            ),
        )
    }

    companion object {
        const val CHANNEL_ALERTS = "alerts"
        const val CHANNEL_UPDATES = "updates"
        const val CHANNEL_SERVICE = "service"
    }
}

/** Android TV (or any device without a touchscreen): D-pad navigation, no background notifications. */
fun Context.isTv(): Boolean {
    val ui = getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    return ui.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
        !packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
}
