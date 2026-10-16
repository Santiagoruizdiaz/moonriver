package com.moonriver.link

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.BatteryManager
import android.os.Environment
import android.os.IBinder
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

enum class LinkStatus { DISCONNECTED, CONNECTING, CONNECTED }

/**
 * Mantiene la conexión con la PC: long-poll de eventos (PC -> teléfono), batería,
 * y las subidas/envíos que piden la UI, "Compartir" y el lector de notificaciones.
 */
class LinkService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sendLock = Mutex()
    private var pollJob: Job? = null
    private lateinit var prefs: Prefs
    private var lastBattery: Pair<Int?, Boolean>? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        createChannels(this)
        ContextCompat.registerReceiver(this, batteryReceiver,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!prefs.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        ServiceCompat.startForeground(this, ONGOING_ID, ongoingNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)

        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_UPLOAD -> {
                val uris = buildList {
                    intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(::add) }
                    intent.data?.let { if (it !in this) add(it) }
                }
                if (uris.isNotEmpty()) scope.launch { uploadAll(uris) }
            }
            ACTION_SEND_TEXT -> intent.getStringExtra(EXTRA_TEXT)?.let { text ->
                scope.launch { send("Texto enviado", text) { it.share(text) } }
            }
            ACTION_SEND_CLIPBOARD -> intent.getStringExtra(EXTRA_TEXT)?.let { text ->
                scope.launch { send("Portapapeles enviado", text.take(80)) { it.clipboard(text) } }
            }
        }
        if (pollJob?.isActive != true) pollJob = scope.launch { pollLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterReceiver(batteryReceiver)
        scope.cancel()
        _status.value = LinkStatus.DISCONNECTED
        super.onDestroy()
    }

    // ── PC -> teléfono ──
    private suspend fun pollLoop() {
        var failures = 0
        while (scope.isActive && prefs.isPaired) {
            val client = LinkClient.forPrefs(prefs) ?: break
            try {
                if (_status.value != LinkStatus.CONNECTED) setStatus(LinkStatus.CONNECTING)
                lastBattery?.let { (level, charging) -> client.status(level, charging) }
                val result = client.events(prefs.lastSeq)
                setStatus(LinkStatus.CONNECTED)
                failures = 0
                val events = result.optJSONArray("events")
                if (events != null) for (i in 0 until events.length()) handleEvent(client, events.getJSONObject(i))
                prefs.lastSeq = result.optLong("seq", prefs.lastSeq)
            } catch (e: LinkException) {
                if (e.code == "unauthorized") {
                    // La PC nos desvinculó
                    prefs.clearPairing()
                    setStatus(LinkStatus.DISCONNECTED)
                    stopSelf()
                    return
                }
                failures++
            } catch (e: Exception) {
                failures++
            }
            if (failures > 0) {
                setStatus(LinkStatus.DISCONNECTED)
                // Si la PC cambió de IP (DHCP), la buscamos de nuevo por su id
                if (failures % 3 == 0) rediscover()
                delay((2000L * failures).coerceAtMost(30_000L))
            }
        }
    }

    private suspend fun rediscover() {
        val pcId = prefs.pcId ?: return
        val pc = Discovery.scan(this).firstOrNull { it.id == pcId && it.fingerprint == prefs.fingerprint } ?: return
        if (pc.host != prefs.host || pc.port != prefs.port) {
            prefs.host = pc.host
            prefs.port = pc.port
        }
    }

    private fun handleEvent(client: LinkClient, e: JSONObject) {
        when (e.optString("type")) {
            "clipboard" -> setClipboard(e.optString("text"))
            "text" -> {
                val text = e.optString("text")
                setClipboard(text)
                notify("Texto de ${prefs.pcName ?: "la PC"} (copiado)", text, null)
            }
            "url" -> {
                val url = e.optString("text")
                val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                notify("Link de ${prefs.pcName ?: "la PC"}", url, open)
            }
            "file" -> receiveFile(client, e.optString("id"), e.optString("name"), e.optLong("size", -1))
        }
    }

    private fun receiveFile(client: LinkClient, id: String, name: String, size: Long) {
        val progressId = nextId.incrementAndGet()
        val nm = getSystemService(NotificationManager::class.java)
        val mime = MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Moonriver Link")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return
        try {
            client.download(id).use { response ->
                contentResolver.openOutputStream(uri)?.use { out ->
                    val input = response.body!!.byteStream()
                    val buf = ByteArray(256 * 1024)
                    var done = 0L
                    var last = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (System.currentTimeMillis() - last > 400) {
                            nm.notify(progressId, progressNotification("Recibiendo $name", done, size))
                            last = System.currentTimeMillis()
                        }
                    }
                }
            }
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            nm.cancel(progressId)
            val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            notify("Archivo recibido", "$name — en Descargas/Moonriver Link", open)
        } catch (e: Exception) {
            contentResolver.delete(uri, null, null)
            nm.cancel(progressId)
            notify("No se pudo recibir $name", e.message ?: "Error de conexión", null)
        }
    }

    private fun setClipboard(text: String) {
        if (text.isEmpty()) return
        val cm = getSystemService(ClipboardManager::class.java)
        scope.launch(Dispatchers.Main) { cm.setPrimaryClip(ClipData.newPlainText("Moonriver Link", text)) }
    }

    // ── teléfono -> PC ──
    private suspend fun uploadAll(uris: List<Uri>) = sendLock.withLock {
        val client = LinkClient.forPrefs(prefs) ?: return@withLock
        val nm = getSystemService(NotificationManager::class.java)
        var ok = 0
        for (uri in uris) {
            val progressId = nextId.incrementAndGet()
            try {
                val name = client.upload(contentResolver, uri) { done, total ->
                    nm.notify(progressId, progressNotification("Enviando a ${prefs.pcName ?: "la PC"}", done, total))
                }
                ok++
                nm.cancel(progressId)
                if (uris.size == 1) notify("Enviado a ${prefs.pcName ?: "la PC"}", name, null)
            } catch (e: Exception) {
                nm.cancel(progressId)
                notify("No se pudo enviar", e.message ?: "Error de conexión", null)
            }
        }
        if (uris.size > 1) notify("Enviado a ${prefs.pcName ?: "la PC"}", "$ok de ${uris.size} archivos", null)
    }

    private suspend fun send(doneTitle: String, doneText: String, action: (LinkClient) -> Unit) = sendLock.withLock {
        val client = LinkClient.forPrefs(prefs) ?: return@withLock
        try {
            action(client)
            notify(doneTitle, doneText, null, quiet = true)
        } catch (e: Exception) {
            notify("No se pudo enviar", e.message ?: "Error de conexión", null)
        }
    }

    private val batteryReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            val pct = if (level >= 0) level * 100 / scale else null
            val current = pct to plugged
            if (current != lastBattery) {
                lastBattery = current
                if (_status.value == LinkStatus.CONNECTED) scope.launch {
                    runCatching { LinkClient.forPrefs(prefs)?.status(pct, plugged) }
                }
            }
        }
    }

    // ── notificaciones ──
    private fun setStatus(s: LinkStatus) {
        if (_status.value == s) return
        _status.value = s
        getSystemService(NotificationManager::class.java).notify(ONGOING_ID, ongoingNotification())
    }

    private fun ongoingNotification(): Notification {
        val pc = prefs.pcName ?: "la PC"
        val text = when (_status.value) {
            LinkStatus.CONNECTED -> "Conectado a $pc"
            LinkStatus.CONNECTING -> "Conectando con $pc…"
            LinkStatus.DISCONNECTED -> "Esperando a $pc"
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_link)
            .setContentTitle("Moonriver Link")
            .setContentText(text)
            .setColor(0xFFA3183A.toInt())
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .build()
    }

    private fun progressNotification(title: String, done: Long, total: Long): Notification =
        NotificationCompat.Builder(this, CHANNEL_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_link)
            .setColor(0xFFA3183A.toInt())
            .setContentTitle(title)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(if (total > 0) 100 else 0, if (total > 0) (done * 100 / total).toInt() else 0, total <= 0)
            .build()

    private fun notify(title: String, text: String, intent: Intent?, quiet: Boolean = false) {
        val builder = NotificationCompat.Builder(this, if (quiet) CHANNEL_TRANSFERS else CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_stat_link)
            .setColor(0xFFA3183A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
        if (intent != null) {
            builder.setContentIntent(PendingIntent.getActivity(this, nextId.incrementAndGet(), intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        getSystemService(NotificationManager::class.java).notify(nextId.incrementAndGet(), builder.build())
    }

    companion object {
        const val ACTION_START = "com.moonriver.link.START"
        const val ACTION_STOP = "com.moonriver.link.STOP"
        const val ACTION_UPLOAD = "com.moonriver.link.UPLOAD"
        const val ACTION_SEND_TEXT = "com.moonriver.link.SEND_TEXT"
        const val ACTION_SEND_CLIPBOARD = "com.moonriver.link.SEND_CLIPBOARD"
        const val EXTRA_TEXT = "text"

        private const val ONGOING_ID = 1
        private const val CHANNEL_ONGOING = "ongoing"
        private const val CHANNEL_EVENTS = "events"
        private const val CHANNEL_TRANSFERS = "transfers"
        private val nextId = AtomicInteger(100)

        private val _status = MutableStateFlow(LinkStatus.DISCONNECTED)
        val status: StateFlow<LinkStatus> = _status

        fun start(context: Context, action: String = ACTION_START, configure: Intent.() -> Unit = {}) {
            val intent = Intent(context, LinkService::class.java).setAction(action).apply(configure)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LinkService::class.java))
        }

        fun createChannels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ONGOING, "Conexión", NotificationManager.IMPORTANCE_MIN))
            nm.createNotificationChannel(NotificationChannel(CHANNEL_TRANSFERS, "Transferencias", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CHANNEL_EVENTS, "Recibido de la PC", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }
}
