package com.n5.minismanager

import android.content.Context

/** Everything the app remembers about this device's setup. */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("minismanager", Context.MODE_PRIVATE)

    /** e.g. https://my-server.tailnet.ts.net:7443 (no trailing slash); null until setup is done */
    var serverUrl: String?
        get() = p.getString("server_url", null)
        set(v) = p.edit().putString("server_url", v).apply()

    var notifications: Boolean
        get() = p.getBoolean("notifications", false)
        set(v) = p.edit().putBoolean("notifications", v).apply()

    var biometric: Boolean
        get() = p.getBoolean("biometric", false)
        set(v) = p.edit().putBoolean("biometric", v).apply()

    /** ntfy settings fetched from the server (/api/app/config) */
    var ntfyUrl: String?
        get() = p.getString("ntfy_url", null)
        set(v) = p.edit().putString("ntfy_url", v).apply()
    var ntfyTopic: String?
        get() = p.getString("ntfy_topic", null)
        set(v) = p.edit().putString("ntfy_topic", v).apply()
    var ntfyToken: String?
        get() = p.getString("ntfy_token", null)
        set(v) = p.edit().putString("ntfy_token", v).apply()

    /** id of the last ntfy message shown, so a reconnect doesn't repeat or miss any */
    var ntfySince: String?
        get() = p.getString("ntfy_since", null)
        set(v) = p.edit().putString("ntfy_since", v).apply()

    /** when the app last went to the background (for the biometric lock) */
    var backgroundAt: Long
        get() = p.getLong("background_at", 0L)
        set(v) = p.edit().putLong("background_at", v).apply()
}
