package com.n5.minismanager

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * Keeps one long-lived connection to ntfy on the server (over Tailscale) and turns each message into a
 * notification — how ntfy itself delivers without Google's push service. The connection shows a
 * silent, minimised "listening" notification, as Android requires for background work.
 */
class NotifyService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    private var conn: HttpURLConnection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = Prefs(this)
        if (!prefs.notifications || prefs.ntfyUrl.isNullOrBlank() || prefs.ntfyTopic.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val ongoing = NotificationCompat.Builder(this, App.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.service_running))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(openApp(null, 0))
            .build()
        ServiceCompat.startForeground(
            this, ONGOING_ID, ongoing,
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        if (!running) {
            running = true
            worker = thread(name = "ntfy") { listen() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        conn?.disconnect()
        worker?.interrupt()
        super.onDestroy()
    }

    private fun listen() {
        var backoff = 5_000L
        while (running) {
            val p = Prefs(this)
            try {
                val since = p.ntfySince ?: "1h"
                val url = URL("${p.ntfyUrl}/${URLEncoder.encode(p.ntfyTopic, "UTF-8")}/json?since=$since")
                val c = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 90_000 // ntfy sends a keepalive every 45 s
                    setRequestProperty("Authorization", "Bearer ${p.ntfyToken}")
                }
                conn = c
                if (c.responseCode != 200) throw IOException("ntfy ${c.responseCode}")
                backoff = 5_000L
                c.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (!running) break
                        val m = runCatching { JSONObject(line) }.getOrNull() ?: continue
                        if (m.optString("event") == "message") {
                            show(m)
                            p.ntfySince = m.optString("id")
                        }
                    }
                }
            } catch (_: Exception) {
                // offline, Tailscale reconnecting, server restarting… try again shortly
            } finally {
                conn?.disconnect()
            }
            if (!running) break
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                break
            }
            backoff = minOf(backoff * 2, 120_000L)
        }
    }

    private fun show(m: JSONObject) {
        val priority = m.optInt("priority", 3)
        val title = m.optString("title").ifBlank { "MinisManager" }
        val body = m.optString("message")
        val id = (m.optString("id").hashCode() and 0x7fffffff)
        val n = NotificationCompat.Builder(this, if (priority >= 4) App.CHANNEL_ALERTS else App.CHANNEL_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(this, R.color.primary))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(if (priority >= 5) NotificationCompat.PRIORITY_MAX else if (priority >= 4) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setWhen(m.optLong("time") * 1000)
            .setContentIntent(openApp(m.optString("click").ifBlank { null }, id))
            .build()
        runCatching { getSystemService(NotificationManager::class.java).notify(id, n) }
    }

    private fun openApp(url: String?, request: Int): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (url != null) i.putExtra(MainActivity.EXTRA_URL, url)
        return PendingIntent.getActivity(this, request, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        private const val ONGOING_ID = 1

        fun start(context: Context) {
            val p = Prefs(context)
            if (!p.notifications || p.ntfyUrl.isNullOrBlank() || context.isTv()) return
            runCatching { ContextCompat.startForegroundService(context, Intent(context, NotifyService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, NotifyService::class.java))
        }

        /** Publishes one message to the topic (App settings → "Send a test notification"). */
        fun sendTest(context: Context): String? {
            val p = Prefs(context)
            return try {
                val c = (URL("${p.ntfyUrl}/${URLEncoder.encode(p.ntfyTopic, "UTF-8")}").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 10_000
                    setRequestProperty("Authorization", "Bearer ${p.ntfyToken}")
                    setRequestProperty("Title", "MinisManager")
                    setRequestProperty("Tags", "white_check_mark")
                }
                c.outputStream.use { it.write("Notifications are working on this phone.".toByteArray()) }
                val code = c.responseCode
                c.disconnect()
                if (code == 200) null else "server answered $code"
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
        }
    }
}

/** After a reboot (or an app update), reconnect if notifications are on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        NotifyService.start(context)
    }
}
