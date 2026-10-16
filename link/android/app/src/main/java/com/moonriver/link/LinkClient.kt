package com.moonriver.link

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class LinkException(val code: String, message: String = code) : IOException(message)

/**
 * Cliente HTTPS de la API de la PC. La PC usa un certificado propio: en lugar de una
 * autoridad, se confía exactamente en la huella SHA-256 recibida al vincular ("pinning").
 */
class LinkClient(
    private val host: String,
    private val port: Int,
    private val fingerprint: String?,      // null = aceptar cualquiera y anotar la huella (solo /hello)
    private val deviceId: String,
    private val token: String? = null,
) {
    @Volatile
    var seenFingerprint: String? = null
        private set

    private val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
            val fp = sha256Hex(chain[0].encoded)
            seenFingerprint = fp
            if (fingerprint != null && !fp.equals(fingerprint, ignoreCase = true))
                throw java.security.cert.CertificateException("La huella del certificado de la PC no coincide")
        }
    }

    private val http: OkHttpClient = run {
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }
        OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trustManager)
            .hostnameVerifier { _, _ -> true }   // la identidad la da la huella, no el nombre
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    private fun url(path: String) = "https://$host:$port$path"

    private fun Request.Builder.auth(): Request.Builder = apply {
        header("X-Device-Id", deviceId)
        token?.let { header("Authorization", "Bearer $it") }
    }

    private fun execJson(request: Request): JSONObject {
        http.newCall(request).execute().use { r -> return parse(r) }
    }

    private fun parse(r: Response): JSONObject {
        val body = r.body?.string().orEmpty()
        val json = runCatching { JSONObject(body) }.getOrDefault(JSONObject())
        if (!r.isSuccessful) throw LinkException(json.optString("error", "http_${r.code}"),
            json.optString("message", json.optString("error", "http_${r.code}")))
        return json
    }

    private fun post(path: String, body: JSONObject): JSONObject = execJson(
        Request.Builder().url(url(path)).auth()
            .post(body.toString().toRequestBody(JSON)).build()
    )

    // ── vinculación ──
    fun hello(): JSONObject = execJson(Request.Builder().url(url("/hello")).build())

    fun pairRequest(name: String): JSONObject =
        post("/pair/request", JSONObject().put("device_id", deviceId).put("name", name))

    fun pairConfirm(code: String): JSONObject =
        post("/pair/confirm", JSONObject().put("device_id", deviceId).put("code", code))

    // ── uso normal ──
    fun events(since: Long): JSONObject =
        execJson(Request.Builder().url(url("/events?since=$since")).auth().get().build())

    fun status(battery: Int?, charging: Boolean) =
        post("/status", JSONObject().put("battery", battery ?: JSONObject.NULL).put("charging", charging))

    fun clipboard(text: String) = post("/clipboard", JSONObject().put("text", text))

    fun share(text: String) = post("/share", JSONObject().put("text", text))

    fun notification(app: String, title: String, text: String) =
        post("/notification", JSONObject().put("app", app).put("title", title).put("text", text))

    // ── agentes (Claude Code / Antigravity) ──
    private fun get(path: String): JSONObject =
        execJson(Request.Builder().url(url(path)).auth().get().build())

    fun agents(): JSONObject = get("/agents")

    fun transcript(kind: String, id: String): JSONObject = get("/agents/$kind/$id")

    fun claudeRun(sessionId: String, text: String, mode: String, title: String): String =
        post("/agents/claude/$sessionId/run", JSONObject().put("text", text).put("mode", mode).put("title", title))
            .getString("job")

    fun job(jobId: String, since: Int): JSONObject = get("/agents/job/$jobId?since=$since")

    fun cancelJob(jobId: String) = post("/agents/job/$jobId/cancel", JSONObject())

    fun antigravitySend(cascadeId: String, text: String, title: String) =
        post("/agents/antigravity/$cascadeId/send", JSONObject().put("text", text).put("title", title))

    fun antigravityCancel(cascadeId: String) = post("/agents/antigravity/$cascadeId/cancel", JSONObject())

    fun upload(resolver: ContentResolver, uri: Uri, onProgress: (Long, Long) -> Unit): String {
        val (name, size) = queryNameAndSize(resolver, uri)
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = size
            override fun writeTo(sink: BufferedSink) {
                val input = resolver.openInputStream(uri) ?: throw IOException("No se pudo leer el archivo")
                input.use { stream -> copyWithProgress(stream, sink, size, onProgress) }
            }
        }
        val encoded = java.net.URLEncoder.encode(name, "UTF-8")
        execJson(Request.Builder().url(url("/upload?name=$encoded")).auth().put(body).build())
        return name
    }

    /** Abre la descarga de un archivo que ofrece la PC. Quien llama cierra la respuesta. */
    fun download(fileId: String): Response {
        val r = http.newCall(Request.Builder().url(url("/files/$fileId")).auth().get().build()).execute()
        if (!r.isSuccessful) {
            r.close()
            throw LinkException("http_${r.code}")
        }
        return r
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun sha256Hex(data: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

        fun forPrefs(prefs: Prefs): LinkClient? {
            if (!prefs.isPaired) return null
            return LinkClient(prefs.host!!, prefs.port, prefs.fingerprint, prefs.deviceId, prefs.token)
        }

        fun queryNameAndSize(resolver: ContentResolver, uri: Uri): Pair<String, Long> {
            var name = uri.lastPathSegment ?: "archivo"
            var size = -1L
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst()) {
                        c.getString(0)?.let { name = it }
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
            return name to size
        }

        private fun copyWithProgress(input: InputStream, sink: BufferedSink, total: Long, onProgress: (Long, Long) -> Unit) {
            val source = input.source()
            var done = 0L
            var lastReport = 0L
            while (true) {
                val read = source.read(sink.buffer, 256 * 1024)
                if (read == -1L) break
                sink.emit()
                done += read
                val now = System.currentTimeMillis()
                if (now - lastReport > 300) {
                    onProgress(done, total)
                    lastReport = now
                }
            }
            onProgress(done, total)
        }
    }
}
