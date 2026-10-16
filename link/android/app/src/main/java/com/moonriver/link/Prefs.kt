package com.moonriver.link

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.util.UUID

/** Datos de la vinculación con la PC, guardados en el teléfono. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("link", Context.MODE_PRIVATE)
    private val appContext = context.applicationContext

    val deviceId: String
        get() = sp.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString("device_id", it).apply()
        }

    val deviceName: String
        get() = Settings.Global.getString(appContext.contentResolver, Settings.Global.DEVICE_NAME)
            ?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}"

    var host: String?
        get() = sp.getString("host", null)
        set(v) = sp.edit().putString("host", v).apply()

    var port: Int
        get() = sp.getInt("port", 41820)
        set(v) = sp.edit().putInt("port", v).apply()

    var fingerprint: String?
        get() = sp.getString("fingerprint", null)
        set(v) = sp.edit().putString("fingerprint", v).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    var pcId: String?
        get() = sp.getString("pc_id", null)
        set(v) = sp.edit().putString("pc_id", v).apply()

    var pcName: String?
        get() = sp.getString("pc_name", null)
        set(v) = sp.edit().putString("pc_name", v).apply()

    var lastSeq: Long
        get() = sp.getLong("last_seq", 0)
        set(v) = sp.edit().putLong("last_seq", v).apply()

    var forwardNotifications: Boolean
        get() = sp.getBoolean("forward_notifications", true)
        set(v) = sp.edit().putBoolean("forward_notifications", v).apply()

    val isPaired: Boolean
        get() = token != null && host != null && fingerprint != null

    fun savePairing(pc: PcInfo, token: String, pcId: String, pcName: String) {
        sp.edit()
            .putString("host", pc.host)
            .putInt("port", pc.port)
            .putString("fingerprint", pc.fingerprint)
            .putString("token", token)
            .putString("pc_id", pcId)
            .putString("pc_name", pcName)
            .putLong("last_seq", 0)
            .apply()
    }

    fun clearPairing() {
        sp.edit()
            .remove("host").remove("fingerprint").remove("token")
            .remove("pc_id").remove("pc_name").remove("last_seq")
            .apply()
    }
}
