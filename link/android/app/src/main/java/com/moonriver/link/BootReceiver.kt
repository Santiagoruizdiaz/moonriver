package com.moonriver.link

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reconecta solo al prender el teléfono o al actualizar la app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs(context).isPaired) runCatching { LinkService.start(context) }
    }
}
