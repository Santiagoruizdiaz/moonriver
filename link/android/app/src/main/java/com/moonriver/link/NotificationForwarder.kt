package com.moonriver.link

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Reenvía a la PC las notificaciones del teléfono (el usuario habilita el acceso en Ajustes). */
class NotificationForwarder : NotificationListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recent = LinkedHashMap<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val prefs = Prefs(this)
        if (!prefs.forwardNotifications || !prefs.isPaired) return
        if (sbn.packageName == packageName || sbn.isOngoing) return
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (LinkService.status.value != LinkStatus.CONNECTED) return

        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (title.isBlank() && text.isBlank()) return

        // Las apps suelen re-publicar la misma notificación: no repetir en 10 s
        val key = "${sbn.packageName}|$title|$text"
        val now = System.currentTimeMillis()
        synchronized(recent) {
            recent.entries.removeAll { now - it.value > 10_000 }
            if (recent.containsKey(key)) return
            recent[key] = now
        }

        val app = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
        }.getOrDefault(sbn.packageName)

        scope.launch { runCatching { LinkClient.forPrefs(prefs)?.notification(app, title, text) } }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
