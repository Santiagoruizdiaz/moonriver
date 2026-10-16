package com.moonriver.link

import android.app.Activity
import android.content.ClipboardManager
import android.widget.Toast

/**
 * Android solo deja leer el portapapeles a la app que tiene el foco: esta actividad
 * invisible aparece un instante, lo lee, lo manda a la PC y se cierra.
 */
class ClipboardActivity : Activity() {
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        val cm = getSystemService(ClipboardManager::class.java)
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (text.isNullOrEmpty()) {
            Toast.makeText(this, "El portapapeles está vacío", Toast.LENGTH_SHORT).show()
        } else if (!Prefs(this).isPaired) {
            Toast.makeText(this, "Primero vinculá el teléfono con tu PC", Toast.LENGTH_SHORT).show()
        } else {
            LinkService.start(this, LinkService.ACTION_SEND_CLIPBOARD) { putExtra(LinkService.EXTRA_TEXT, text) }
            Toast.makeText(this, "Portapapeles enviado a la PC", Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}
