package com.n5.minismanager

import android.webkit.CookieManager
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLPeerUnverifiedException

/** Talking to NovaOS: finding it during setup, and calling its API as the signed-in user. */
object Server {
    class Found(val url: String, val version: String, val viaName: String?)

    /**
     * "my-server.tailnet.ts.net", "100.64.0.5", "https://host:7443"… → a working server URL.
     * NovaOS's HTTPS certificate is for its name, not its IP: when an IP is typed, the
     * certificate's own name is read and used instead (it resolves through Tailscale).
     */
    fun probe(input: String, portInput: String): Found {
        var raw = input.trim().removeSuffix("/")
        if (raw.isEmpty()) throw IOException("Enter the server address")
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw = "https://$raw"
        val u = URL(raw)
        val port = when {
            u.port != -1 -> u.port
            portInput.isNotBlank() -> portInput.trim().toIntOrNull() ?: throw IOException("The port must be a number")
            else -> 7443
        }
        // An IP (e.g. Tailscale's 100.x): HTTPS needs the server's name. Tailscale's DNS knows it.
        if (IP.matches(u.host)) {
            val name = runCatching { java.net.InetAddress.getByName(u.host).canonicalHostName }.getOrNull()
            if (name != null && name != u.host) {
                val named = "https://$name:$port"
                return Found(named, health(named), u.host)
            }
        }
        val base = "${u.protocol}://${u.host}:$port"
        return try {
            Found(base, health(base), null)
        } catch (e: SSLPeerUnverifiedException) {
            val name = certificateName(u.host, port) ?: throw IOException("The server's certificate doesn't match ${u.host}")
            val named = "https://$name:$port"
            Found(named, health(named), u.host)
        } catch (e: javax.net.ssl.SSLException) {
            if (IP.matches(u.host)) throw IOException("This address needs the server's name for a secure connection. Type the name instead, e.g. my-server.tailnet.ts.net")
            throw e
        }
    }

    private val IP = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

    private fun health(base: String): String {
        val c = URL("$base/api/health").openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        try {
            if (c.responseCode != 200) throw IOException("The server answered ${c.responseCode} — is this NovaOS?")
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            if (!j.optBoolean("ok")) throw IOException("That doesn't look like NovaOS")
            return j.optString("version", "?")
        } finally {
            c.disconnect()
        }
    }

    /** The DNS name in the server's certificate (read without trusting it for anything else). */
    private fun certificateName(host: String, port: Int): String? {
        var name: String? = null
        val c = URL("https://$host:$port/api/health").openConnection() as HttpsURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, session ->
            val cert = session.peerCertificates.firstOrNull() as? X509Certificate
            name = cert?.subjectAlternativeNames?.firstOrNull { it[0] == 2 }?.get(1) as? String
            false
        }
        try {
            c.responseCode
        } catch (_: IOException) {
            // expected: the name doesn't match the IP; we only wanted the certificate
        } finally {
            c.disconnect()
        }
        return name?.takeIf { !it.startsWith("*") }
    }

    /** An API call with the WebView's session (the user signs in once, in the app). */
    fun call(base: String, method: String, path: String, json: JSONObject? = null): Pair<Int, JSONObject?> {
        val c = URL("$base$path").openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10000
        c.readTimeout = 30000
        authorize(c, base)
        if (json != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(json.toString().toByteArray()) }
        }
        try {
            val code = c.responseCode
            val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText()
            return code to body?.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }
        } finally {
            c.disconnect()
        }
    }

    /** Session cookie from the WebView, and the Origin NovaOS checks on every change. */
    fun authorize(c: HttpURLConnection, base: String) {
        CookieManager.getInstance().getCookie(base)?.let { c.setRequestProperty("Cookie", it) }
        c.setRequestProperty("Origin", base)
        c.setRequestProperty("User-Agent", "MinisManagerApp/${BuildConfig.VERSION_NAME}")
    }
}
