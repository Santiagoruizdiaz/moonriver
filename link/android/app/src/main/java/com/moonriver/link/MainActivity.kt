package com.moonriver.link

import android.Manifest
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        LinkService.createChannels(this)
        if (Prefs(this).isPaired) LinkService.start(this)
        setContent { MoonriverTheme { App() } }
    }
}

private enum class Tab(val label: String, val icon: ImageVector) {
    HOME("Inicio", Icons.Default.Home),
    AGENTS("Agentes", Icons.Default.Build),
    SETTINGS("Ajustes", Icons.Default.Settings),
}

@Composable
private fun App() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    var paired by remember { mutableStateOf(prefs.isPaired) }

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    Box(Modifier.fillMaxSize().background(Mr.Black)) {
        if (!paired) {
            Column(
                Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                    .verticalScroll(rememberScrollState()).padding(ScreenPadding),
                verticalArrangement = Gap,
            ) {
                BrandHeader()
                PairingScreen(prefs, onPaired = {
                    paired = true
                    LinkService.start(context)
                })
            }
        } else {
            PairedApp(prefs, onUnpaired = { paired = false })
        }
    }
}

@Composable
private fun PairedApp(prefs: Prefs, onUnpaired: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    var chat by remember { mutableStateOf<AgentConversation?>(null) }

    val openChat = chat
    if (openChat != null) {
        Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            ChatScreen(prefs, openChat, onBack = { chat = null })
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).statusBarsPadding()) {
            AnimatedContent(tab, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "tab") { current ->
                when (current) {
                    Tab.HOME -> HomeScreen(prefs, onOpenAgents = { tab = Tab.AGENTS })
                    Tab.AGENTS -> AgentsScreen(prefs, onOpen = { chat = it })
                    Tab.SETTINGS -> SettingsScreen(prefs, onUnpaired)
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Mr.Line))
        NavigationBar(containerColor = Mr.Surface, tonalElevation = 0.dp, modifier = Modifier.navigationBarsPadding()) {
            Tab.entries.forEach { t ->
                NavigationBarItem(
                    selected = tab == t,
                    onClick = { tab = t },
                    icon = { Icon(t.icon, t.label) },
                    label = { Text(t.label, fontSize = 12.sp) },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = Color.White, selectedTextColor = Mr.Text,
                        indicatorColor = Mr.BordoLive,
                        unselectedIconColor = Mr.TextSoft, unselectedTextColor = Mr.TextSoft,
                    ),
                )
            }
        }
    }
}

@Composable
private fun BrandHeader() {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp, bottom = 6.dp)) {
        Icon(painterResource(R.drawable.ic_stat_link), null, tint = Mr.BordoBright, modifier = Modifier.size(30.dp))
        Spacer(Modifier.width(12.dp))
        Text("MOONRIVER", color = Mr.Text, fontSize = 18.sp, fontWeight = FontWeight.Light, letterSpacing = 5.sp)
        Spacer(Modifier.width(8.dp))
        Text("LINK", color = Mr.BordoBright, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 5.sp)
    }
}

// ───────────────────────────── inicio ─────────────────────────────

@Composable
private fun HomeScreen(prefs: Prefs, onOpenAgents: () -> Unit) {
    val context = LocalContext.current
    val status by LinkService.status.collectAsStateWithLifecycle()
    val pc = prefs.pcName ?: "PC"
    var showText by remember { mutableStateOf(false) }
    val connected = status == LinkStatus.CONNECTED

    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            val clip = ClipData.newRawUri("files", uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
            LinkService.start(context, LinkService.ACTION_UPLOAD) {
                clipData = clip
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Gap,
    ) {
        BrandHeader()

        HeroCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val (dot, label) = when (status) {
                    LinkStatus.CONNECTED -> Mr.Glow to "Conectado"
                    LinkStatus.CONNECTING -> Mr.BordoLive to "Conectando…"
                    LinkStatus.DISCONNECTED -> Mr.TextSoft to "Sin conexión"
                }
                StatusDot(dot, pulse = status == LinkStatus.CONNECTING)
                Spacer(Modifier.width(8.dp))
                Text(label.uppercase(), color = dot, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
            }
            Spacer(Modifier.height(14.dp))
            Text(pc, color = Mr.Text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text(
                if (connected) "Todo lo que compartas llega al instante" else "Asegurate de estar en la misma red wifi",
                color = Mr.TextSoft, fontSize = 14.sp,
            )
        }

        SectionLabel("Enviar a $pc")
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ActionTile(Icons.Default.Add, "Archivos", "Fotos, videos y documentos", Modifier.weight(1f), connected) { pickFiles.launch("*/*") }
            ActionTile(Icons.Default.Share, "Portapapeles", "Lo que copiaste acá", Modifier.weight(1f), connected) {
                context.startActivity(Intent(context, ClipboardActivity::class.java))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ActionTile(Icons.AutoMirrored.Filled.Send, "Link o texto", "Los links se abren en la PC", Modifier.weight(1f), connected) { showText = true }
            ActionTile(Icons.Default.Build, "Agentes", "Claude y Antigravity", Modifier.weight(1f)) { onOpenAgents() }
        }

        MrCard {
            Row(verticalAlignment = Alignment.Top) {
                Icon(Icons.Default.Info, null, tint = Mr.BordoBright, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    "Desde cualquier app: Compartir → «Enviar a la PC». Sumá el botón «Portapapeles → PC» a los ajustes rápidos para mandar lo copiado con un toque.",
                    color = Mr.TextSoft, fontSize = 13.sp, lineHeight = 18.sp,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }

    if (showText) SendTextDialog(onDismiss = { showText = false }) { text ->
        showText = false
        LinkService.start(context, LinkService.ACTION_SEND_TEXT) { putExtra(LinkService.EXTRA_TEXT, text) }
    }
}

@Composable
private fun SendTextDialog(onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Mr.Surface,
        title = { Text("Enviar a la PC", color = Mr.Text) },
        text = { MrTextField(text, { text = it }, "https://… o cualquier texto", Modifier.fillMaxWidth(), KeyboardType.Uri) },
        confirmButton = { MrButton("Enviar", enabled = text.isNotBlank()) { onSend(text.trim()) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar", color = Mr.TextSoft) } },
    )
}

// ───────────────────────────── ajustes ─────────────────────────────

@Composable
private fun SettingsScreen(prefs: Prefs, onUnpaired: () -> Unit) {
    val context = LocalContext.current
    val pc = prefs.pcName ?: "PC"
    var forward by remember { mutableStateOf(prefs.forwardNotifications) }
    var listenerEnabled by remember { mutableStateOf(isListenerEnabled(context)) }
    var ignoringBattery by remember { mutableStateOf(isIgnoringBattery(context)) }
    var confirmUnpair by remember { mutableStateOf(false) }

    LifecycleResumeEffect(Unit) {
        listenerEnabled = isListenerEnabled(context)
        ignoringBattery = isIgnoringBattery(context)
        onPauseOrDispose { }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Gap,
    ) {
        Text("Ajustes", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Mr.Text, modifier = Modifier.padding(top = 10.dp))

        SectionLabel("Integración")
        MrCard {
            SettingSwitch(
                "Notificaciones en la PC",
                if (listenerEnabled) "Las notificaciones del teléfono aparecen en $pc" else "Falta dar acceso a las notificaciones",
                checked = forward && listenerEnabled,
            ) { on ->
                forward = on
                prefs.forwardNotifications = on
                if (on && !listenerEnabled) context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
            if (!ignoringBattery) {
                ListRow(Icons.Default.Notifications, "Mantener conectado", "Quitar la optimización de batería") {
                    runCatching {
                        context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:${context.packageName}")))
                    }
                }
            }
        }

        SectionLabel("Vinculación")
        MrCard {
            Text(pc, color = Mr.Text, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Text("${prefs.host}:${prefs.port}", color = Mr.TextSoft, fontSize = 13.sp)
            Text("Huella ${prefs.fingerprint?.take(16)?.chunked(4)?.joinToString(" ")}…", color = Mr.TextSoft, fontSize = 12.sp)
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = { confirmUnpair = true }) { Text("Desvincular de $pc", color = Mr.Glow) }
        }

        Text("Moonriver Link 1.1", color = Mr.Line, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp, bottom = 12.dp))
    }

    if (confirmUnpair) AlertDialog(
        onDismissRequest = { confirmUnpair = false },
        containerColor = Mr.Surface,
        title = { Text("¿Desvincular?", color = Mr.Text) },
        text = { Text("El teléfono deja de conectarse con $pc hasta que lo vuelvas a vincular.", color = Mr.TextSoft) },
        confirmButton = {
            MrButton("Desvincular") {
                LinkService.stop(context)
                prefs.clearPairing()
                confirmUnpair = false
                onUnpaired()
            }
        },
        dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancelar", color = Mr.TextSoft) } },
    )
}

private fun isListenerEnabled(context: Context): Boolean {
    val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
    val me = ComponentName(context, NotificationForwarder::class.java).flattenToString()
    return flat.split(':').any { it == me }
}

private fun isIgnoringBattery(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

// ───────────────────────────── vinculación ─────────────────────────────

@Composable
private fun PairingScreen(prefs: Prefs, onPaired: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var scanning by remember { mutableStateOf(false) }
    var pcs by remember { mutableStateOf<List<PcInfo>>(emptyList()) }
    var selected by remember { mutableStateOf<PcInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var manualIp by remember { mutableStateOf("") }
    var scanCount by remember { mutableIntStateOf(0) }

    LaunchedEffect(scanCount) {
        scanning = true
        error = null
        pcs = Discovery.scan(context, 2500)
        scanning = false
    }

    fun requestPairing(pc: PcInfo) {
        scope.launch {
            error = null
            try {
                withContext(Dispatchers.IO) {
                    LinkClient(pc.host, pc.port, pc.fingerprint, prefs.deviceId).pairRequest(prefs.deviceName)
                }
                selected = pc
            } catch (e: Exception) {
                error = "No se pudo contactar a ${pc.name}: ${e.message}"
            }
        }
    }

    HeroCard {
        Text("Conectá tu PC", color = Mr.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("Con el teléfono y la PC en la misma red wifi, tocá tu PC y escribí el código que aparece en su pantalla.",
            color = Mr.TextSoft, fontSize = 14.sp, lineHeight = 20.sp)
    }

    SectionLabel("PCs en tu red") {
        if (scanning) CircularProgressIndicator(Modifier.size(16.dp), color = Mr.BordoBright, strokeWidth = 2.dp)
        else Icon(Icons.Default.Refresh, "Buscar de nuevo", tint = Mr.BordoBright,
            modifier = Modifier.size(20.dp).clickable { scanCount++ })
    }
    if (!scanning && pcs.isEmpty()) EmptyState("No se encontró ninguna PC. Revisá que Moonriver Link esté corriendo.")
    pcs.forEach { pc ->
        MrCard(onClick = { requestPairing(pc) }, padding = 16.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(Mr.BordoDeep), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_stat_link), null, tint = Mr.Glow, modifier = Modifier.size(22.dp))
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(pc.name, fontWeight = FontWeight.SemiBold, color = Mr.Text, fontSize = 16.sp)
                    Text(pc.host, fontSize = 12.sp, color = Mr.TextSoft)
                }
                Pill("Vincular")
            }
        }
    }

    SectionLabel("Conectar por IP")
    MrCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MrTextField(manualIp, { manualIp = it.trim() }, "192.168.1.10", Modifier.weight(1f), KeyboardType.Uri)
            Spacer(Modifier.width(10.dp))
            MrButton("Conectar", enabled = manualIp.isNotBlank()) {
                scope.launch {
                    error = null
                    try {
                        val pc = withContext(Dispatchers.IO) {
                            val probe = LinkClient(manualIp, 41820, null, prefs.deviceId)
                            val hello = probe.hello()
                            val fp = probe.seenFingerprint ?: error("sin certificado")
                            if (!fp.equals(hello.getString("fingerprint"), ignoreCase = true)) error("huella inconsistente")
                            PcInfo(hello.getString("id"), hello.getString("name"), manualIp, 41820, fp)
                        }
                        requestPairing(pc)
                    } catch (e: Exception) {
                        error = "No se pudo conectar a $manualIp: ${e.message}"
                    }
                }
            }
        }
    }

    error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp) }

    selected?.let { pc ->
        CodeDialog(pc, prefs, onDismiss = { selected = null }, onPaired = {
            selected = null
            onPaired()
        })
    }
}

@Composable
private fun CodeDialog(pc: PcInfo, prefs: Prefs, onDismiss: () -> Unit, onPaired: () -> Unit) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Mr.Surface,
        title = { Text("Código de ${pc.name}", color = Mr.Text) },
        text = {
            Column {
                Text("Escribí el código de 6 dígitos que apareció en la pantalla de la PC.", color = Mr.TextSoft)
                Spacer(Modifier.height(14.dp))
                MrTextField(code, { v -> code = v.filter(Char::isDigit).take(6) }, "000000",
                    Modifier.fillMaxWidth(), KeyboardType.Number, big = true)
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            MrButton(if (busy) "Vinculando…" else "Vincular", enabled = code.length == 6 && !busy) {
                scope.launch {
                    busy = true
                    error = null
                    try {
                        val result = withContext(Dispatchers.IO) {
                            LinkClient(pc.host, pc.port, pc.fingerprint, prefs.deviceId).pairConfirm(code)
                        }
                        prefs.savePairing(pc, result.getString("token"), result.getString("pc_id"), result.getString("pc_name"))
                        onPaired()
                    } catch (e: LinkException) {
                        error = when (e.code) {
                            "wrong_code" -> "Código incorrecto"
                            "expired" -> "El código venció. Cerrá y volvé a tocar la PC."
                            "too_many_attempts" -> "Demasiados intentos. Volvé a empezar."
                            else -> e.message
                        }
                    } catch (e: Exception) {
                        error = e.message
                    }
                    busy = false
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar", color = Mr.TextSoft) } },
    )
}
