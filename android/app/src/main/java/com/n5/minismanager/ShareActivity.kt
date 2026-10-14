package com.n5.minismanager

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.n5.minismanager.databinding.ActivityShareBinding
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

/**
 * "Send to NovaOS" from any app: a magnet or torrent link goes to qBittorrent (and into Jellyfin when
 * done), a web link is downloaded with yt-dlp (video or audio), files are uploaded to Files.
 * Uses the session the user signed in with inside the app.
 */
class ShareActivity : AppCompatActivity() {
    private lateinit var b: ActivityShareBinding
    private var base: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityShareBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.close.setOnClickListener { finish() }
        base = Prefs(this).serverUrl
        if (base == null) return fail(getString(R.string.share_setup))

        val files = streams(intent)
        val text = (intent.data?.toString() ?: intent.getStringExtra(Intent.EXTRA_TEXT))?.trim()
        when {
            files.isNotEmpty() -> {
                b.preview.text = files.joinToString("\n") { nameOf(it) }
                action(getString(R.string.share_upload, files.size)) { upload(files) }
            }
            text != null && MAGNET.containsMatchIn(text) -> {
                val link = MAGNET.find(text)!!.value
                // magnet: links are opaque URIs — read the display name (dn=) by hand.
                b.preview.text = Regex("[?&]dn=([^&]+)").find(link)?.groupValues?.get(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: link
                action(getString(R.string.share_torrent)) { send("torrent", link, false) }
            }
            text != null && URL_RE.containsMatchIn(text) -> {
                val link = URL_RE.find(text)!!.value
                b.preview.text = link
                if (link.substringBefore('?').endsWith(".torrent", ignoreCase = true)) {
                    action(getString(R.string.share_torrent)) { send("torrent", link, false) }
                } else {
                    action(getString(R.string.share_video)) { send("video", link, false) }
                    action(getString(R.string.share_audio), secondary = true) { send("video", link, true) }
                }
            }
            else -> fail(getString(R.string.share_nothing))
        }
    }

    private fun action(label: String, secondary: Boolean = false, run: () -> Unit) {
        val btn = MaterialButton(this, null, if (secondary) com.google.android.material.R.attr.materialButtonOutlinedStyle else com.google.android.material.R.attr.materialButtonStyle).apply {
            text = label
            minHeight = (56 * resources.displayMetrics.density).toInt()
            cornerRadius = (14 * resources.displayMetrics.density).toInt()
            setOnClickListener { busy(); run() }
        }
        b.actions.addView(btn, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = (6 * resources.displayMetrics.density).toInt()
        })
        if (b.actions.childCount == 1) btn.requestFocus()
    }

    private fun busy() {
        b.actions.visibility = View.GONE
        b.progress.visibility = View.VISIBLE
        status(getString(R.string.share_sending), ok = true)
    }

    private fun status(text: String, ok: Boolean) {
        b.status.visibility = View.VISIBLE
        b.status.text = text
        b.status.setTextColor(ContextCompat.getColor(this, if (ok) R.color.ink else R.color.danger))
    }

    private fun fail(text: String) {
        b.progress.visibility = View.GONE
        b.actions.visibility = View.GONE
        status(text, ok = false)
    }

    private fun done(text: String) {
        b.progress.visibility = View.GONE
        status("✓ $text", ok = true)
        b.close.requestFocus()
    }

    private fun send(kind: String, value: String, audio: Boolean) = thread {
        val r = runCatching { Server.call(base!!, "POST", "/api/app/share", JSONObject().put("kind", kind).put("value", value).put("audio", audio)) }
        runOnUiThread {
            r.onSuccess { (code, j) ->
                when {
                    code == 401 -> fail(getString(R.string.share_signin))
                    j?.optBoolean("ok") == true -> done(j.optString("message"))
                    else -> fail(j?.optString("message")?.ifBlank { null } ?: "The server answered $code")
                }
            }.onFailure { fail(it.message ?: "Couldn't reach the server") }
        }
    }

    /** One multipart request per file to /api/fs/upload (sorted into Files by type), streamed. */
    private fun upload(files: List<Uri>) = thread {
        var ok = 0
        try {
            for ((i, uri) in files.withIndex()) {
                runOnUiThread { status(getString(R.string.share_uploading, i + 1, files.size), ok = true) }
                val boundary = "----mm" + UUID.randomUUID().toString().replace("-", "")
                val c = (URL("$base/api/fs/upload").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 15_000
                    readTimeout = 600_000
                    setChunkedStreamingMode(256 * 1024)
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                }
                Server.authorize(c, base!!)
                val name = nameOf(uri).replace("\"", "'")
                val type = contentResolver.getType(uri) ?: "application/octet-stream"
                c.outputStream.use { out ->
                    out.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$name\"\r\nContent-Type: $type\r\n\r\n".toByteArray())
                    contentResolver.openInputStream(uri)?.use { it.copyTo(out, 256 * 1024) } ?: throw IOException("Can't read $name")
                    out.write("\r\n--$boundary--\r\n".toByteArray())
                }
                val code = c.responseCode
                c.disconnect()
                if (code == 401) throw IOException(getString(R.string.share_signin))
                if (code !in 200..299) throw IOException("Upload of $name failed ($code)")
                ok++
            }
            runOnUiThread { done(getString(R.string.share_uploaded, ok)) }
        } catch (e: Exception) {
            runOnUiThread { fail(e.message ?: "Upload failed") }
        }
    }

    private fun streams(i: Intent): List<Uri> {
        val list = mutableListOf<Uri>()
        if (i.action == Intent.ACTION_SEND_MULTIPLE) {
            (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableArrayListExtra(Intent.EXTRA_STREAM))?.let { list.addAll(it) }
        } else if (i.action == Intent.ACTION_SEND) {
            (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM))?.let { list.add(it) }
        }
        return list
    }

    private fun nameOf(uri: Uri): String =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        } ?: uri.lastPathSegment ?: "file"

    companion object {
        private val MAGNET = Regex("magnet:\\?xt=urn:bt[im]h:[^\\s\"'<>]+", RegexOption.IGNORE_CASE)
        private val URL_RE = Regex("https?://[^\\s\"'<>]+", RegexOption.IGNORE_CASE)
    }
}
