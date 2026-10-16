package com.moonriver.link

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.IntentCompat

/** Destino de "Compartir": manda archivos, links o texto a la PC y se cierra. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        if (!prefs.isPaired) {
            Toast.makeText(this, "Primero vinculá el teléfono con tu PC", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        val pc = prefs.pcName ?: "la PC"

        if (uris.isNotEmpty()) {
            // Pasamos los permisos de lectura al servicio, que hace la subida
            val clip = ClipData.newRawUri("files", uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
            LinkService.start(this, LinkService.ACTION_UPLOAD) {
                clipData = clip
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            Toast.makeText(this, "Enviando ${if (uris.size == 1) "archivo" else "${uris.size} archivos"} a $pc…", Toast.LENGTH_SHORT).show()
        } else {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
            if (!text.isNullOrEmpty()) {
                LinkService.start(this, LinkService.ACTION_SEND_TEXT) { putExtra(LinkService.EXTRA_TEXT, text) }
                Toast.makeText(this, "Enviado a $pc", Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }
}
