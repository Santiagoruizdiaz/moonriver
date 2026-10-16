package com.moonriver.link

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class AgentConversation(
    val kind: String,          // "claude" | "antigravity"
    val id: String,
    val title: String,
    val project: String,
    val preview: String,
    val running: Boolean,
    val busy: Boolean,
)

data class ChatMessage(val role: String, val text: String)

private class AgentsState(
    val control: Boolean,
    val claudeAvailable: Boolean,
    val claude: List<AgentConversation>,
    val antigravityRunning: Boolean,
    val antigravity: List<AgentConversation>,
    val antigravityError: String?,
)

private fun parseConversations(kind: String, arr: JSONArray?): List<AgentConversation> =
    (0 until (arr?.length() ?: 0)).map { i ->
        val o = arr!!.getJSONObject(i)
        AgentConversation(kind, o.getString("id"), o.optString("title"), o.optString("project"),
            o.optString("preview"), o.optBoolean("running"), o.optBoolean("busy"))
    }

private fun parseAgents(o: JSONObject): AgentsState {
    val c = o.getJSONObject("claude")
    val a = o.getJSONObject("antigravity")
    return AgentsState(
        control = o.optBoolean("control", true),
        claudeAvailable = c.optBoolean("available"),
        claude = parseConversations("claude", c.optJSONArray("sessions")),
        antigravityRunning = a.optBoolean("running"),
        antigravity = parseConversations("antigravity", a.optJSONArray("sessions")),
        antigravityError = a.optString("error").ifBlank { null },
    )
}

private fun cleanMarkdown(text: String) = text.replace("**", "").replace("`", "")

// ───────────────────────────── lista de agentes ─────────────────────────────

@Composable
fun AgentsScreen(prefs: Prefs, onOpen: (AgentConversation) -> Unit) {
    val status by LinkService.status.collectAsStateWithLifecycle()
    var state by remember { mutableStateOf<AgentsState?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }

    LaunchedEffect(refresh, status) {
        while (isActive) {
            try {
                val data = withContext(Dispatchers.IO) { LinkClient.forPrefs(prefs)?.agents() }
                state = data?.let(::parseAgents)
                error = null
            } catch (e: Exception) {
                error = if (status == LinkStatus.CONNECTED) e.message else "Sin conexión con la PC"
            }
            delay(8000)
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Gap,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Agentes", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Mr.Text)
                Text("Tus conversaciones activas en ${prefs.pcName ?: "la PC"}", color = Mr.TextSoft, fontSize = 14.sp)
            }
            IconButton(onClick = { refresh++ }) { Icon(Icons.Default.Refresh, "Actualizar", tint = Mr.BordoBright) }
        }

        error?.let { MrCard { Text(it, color = Mr.TextSoft) } }
        val s = state
        if (s == null && error == null) {
            Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Mr.BordoBright, strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("Cargando…", color = Mr.TextSoft)
            }
        }
        if (s != null) {
            if (!s.control) {
                MrCard {
                    Text("Control desactivado en la PC", color = Mr.Glow, fontWeight = FontWeight.SemiBold)
                    Text("Podés ver las conversaciones, pero para darles órdenes activá «Controlar agentes desde el teléfono» en el menú del teléfono del panel de Moonriver.",
                        color = Mr.TextSoft, fontSize = 13.sp)
                }
            }

            SectionLabel("Claude Code") { if (s.claude.any { it.running }) Pill("en uso") }
            when {
                !s.claudeAvailable -> EmptyState("Claude Code no está instalado en la PC.")
                s.claude.isEmpty() -> EmptyState("No hay conversaciones todavía.")
                else -> s.claude.forEach { ConversationCard(it) { onOpen(it) } }
            }

            SectionLabel("Antigravity") { if (s.antigravityRunning) Pill("abierto") }
            when {
                !s.antigravityRunning -> MrCard {
                    Text("Antigravity está cerrado", color = Mr.Text, fontWeight = FontWeight.SemiBold)
                    Text("Abrilo en la PC para ver y controlar sus conversaciones desde acá.", color = Mr.TextSoft, fontSize = 13.sp)
                }
                s.antigravityError != null -> EmptyState("No se pudo leer Antigravity: ${s.antigravityError}")
                s.antigravity.isEmpty() -> EmptyState("No hay conversaciones todavía.")
                else -> s.antigravity.forEach { ConversationCard(it) { onOpen(it) } }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun ConversationCard(c: AgentConversation, onClick: () -> Unit) {
    MrCard(onClick = onClick, padding = 16.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgentBadge(c.kind)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(c.title, color = Mr.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (c.project.isNotBlank()) Text(c.project, color = Mr.TextSoft, fontSize = 12.sp, maxLines = 1)
            }
            when {
                c.busy -> StatusDot(Mr.Glow, pulse = true)
                c.running -> StatusDot(Mr.BordoLive)
                else -> StatusDot(Mr.Line)
            }
        }
        if (c.preview.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            Text(cleanMarkdown(c.preview), color = Mr.TextSoft, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun AgentBadge(kind: String) {
    val (letter, bg) = if (kind == "claude") "C" to Color(0xFF5A1E14) else "A" to Color(0xFF1B1A3A)
    Box(Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(bg), contentAlignment = Alignment.Center) {
        Text(letter, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
}

// ───────────────────────────── chat con un agente ─────────────────────────────

private val CLAUDE_MODES = listOf(
    Triple("plan", "Planear", "Solo analiza y propone; no toca archivos"),
    Triple("acceptEdits", "Editar", "Puede editar archivos del proyecto"),
    Triple("auto", "Auto", "Decide solo qué acciones son seguras"),
)

@Composable
fun ChatScreen(prefs: Prefs, conversation: AgentConversation, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val scope = rememberCoroutineScope()
    val messages = remember { mutableStateListOf<ChatMessage>() }
    val live = remember { mutableStateListOf<ChatMessage>() }
    var input by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("acceptEdits") }
    var working by remember { mutableStateOf(false) }
    var jobId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var watchUntil by remember { mutableStateOf(0L) }
    val listState = rememberLazyListState()
    val isClaude = conversation.kind == "claude"

    suspend fun reload() {
        try {
            val data = withContext(Dispatchers.IO) { LinkClient.forPrefs(prefs)?.transcript(conversation.kind, conversation.id) }
            val arr = data?.optJSONArray("messages") ?: return
            messages.clear()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                messages.add(ChatMessage(o.getString("role"), o.getString("text")))
            }
        } catch (e: Exception) {
            error = e.message
        }
    }

    LaunchedEffect(Unit) { reload() }

    // Claude: seguir la salida del trabajo en curso
    LaunchedEffect(jobId) {
        val id = jobId ?: return@LaunchedEffect
        var since = 0
        while (isActive) {
            try {
                val j = withContext(Dispatchers.IO) { LinkClient.forPrefs(prefs)?.job(id, since) } ?: break
                val events = j.optJSONArray("events") ?: JSONArray()
                for (i in 0 until events.length()) {
                    val e = events.getJSONObject(i)
                    since = e.getInt("i") + 1
                    val role = when (e.getString("kind")) {
                        "text" -> "assistant"; "tool" -> "tool"; "error" -> "error"; else -> "info"
                    }
                    live.add(ChatMessage(role, e.getString("text")))
                }
                if (j.optBoolean("done")) break
            } catch (_: Exception) {
            }
            delay(900)
        }
        working = false
        jobId = null
        reload()
        live.removeAll { it.role != "error" && it.role != "info" }
    }

    // Antigravity: no hay "trabajo" para seguir; se relee la conversación un rato
    LaunchedEffect(watchUntil) {
        while (isActive && System.currentTimeMillis() < watchUntil) {
            delay(2500)
            reload()
        }
        if (!isClaude) working = false
    }

    LaunchedEffect(messages.size, live.size) {
        val total = messages.size + live.size
        if (total > 0) listState.animateScrollToItem(total - 1)
    }

    fun send() {
        val text = input.trim()
        if (text.isEmpty() || working) return
        input = ""
        error = null
        live.clear()
        live.add(ChatMessage("user", text))
        working = true
        scope.launch {
            try {
                val client = LinkClient.forPrefs(prefs) ?: error("No vinculado")
                if (isClaude) {
                    jobId = withContext(Dispatchers.IO) { client.claudeRun(conversation.id, text, mode, conversation.title) }
                } else {
                    withContext(Dispatchers.IO) { client.antigravitySend(conversation.id, text, conversation.title) }
                    watchUntil = System.currentTimeMillis() + 3 * 60_000
                }
            } catch (e: Exception) {
                error = e.message
                working = false
            }
        }
    }

    fun stop() {
        scope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val client = LinkClient.forPrefs(prefs)
                    if (isClaude) jobId?.let { client?.cancelJob(it) } else client?.antigravityCancel(conversation.id)
                }
            }
            watchUntil = 0
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        // Barra superior
        Row(
            Modifier.fillMaxWidth().background(Mr.Black).padding(horizontal = 6.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Volver", tint = Mr.Text) }
            AgentBadge(conversation.kind)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(conversation.title, color = Mr.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    (if (isClaude) "Claude Code" else "Antigravity") + if (conversation.project.isNotBlank()) " · ${conversation.project}" else "",
                    color = Mr.TextSoft, fontSize = 12.sp, maxLines = 1,
                )
            }
            if (working) StatusDot(Mr.Glow, pulse = true)
            Spacer(Modifier.width(12.dp))
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Mr.Line))

        // Mensajes
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(messages + live) { MessageBubble(it) }
            if (working) item {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp, top = 4.dp)) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = Mr.BordoBright, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (isClaude) "Claude está trabajando…" else "Enviado a Antigravity, esperando respuesta…",
                        color = Mr.TextSoft, fontSize = 13.sp)
                }
            }
        }

        error?.let {
            Text(it, color = Color(0xFFFF8A8A), fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }

        // Compositor
        Column(Modifier.fillMaxWidth().background(Mr.Surface).padding(horizontal = 12.dp, vertical = 10.dp)) {
            if (isClaude) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                    CLAUDE_MODES.forEach { (id, label, _) ->
                        val selected = mode == id
                        Text(
                            label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            color = if (selected) Color.White else Mr.TextSoft,
                            modifier = Modifier
                                .clip(RoundedCornerShape(50))
                                .background(if (selected) Mr.BordoLive else Mr.Elevated)
                                .border(1.dp, if (selected) Mr.BordoLive else Mr.Line, RoundedCornerShape(50))
                                .clickable { mode = id }
                                .padding(horizontal = 14.dp, vertical = 6.dp),
                        )
                    }
                }
                Text(CLAUDE_MODES.first { it.first == mode }.third, color = Mr.TextSoft, fontSize = 11.sp,
                    modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
            }
            Row(verticalAlignment = Alignment.Bottom) {
                MrTextField(input, { input = it }, if (isClaude) "Pedile algo a Claude…" else "Pedile algo a Antigravity…",
                    Modifier.weight(1f), singleLine = false, maxLines = 5)
                Spacer(Modifier.width(8.dp))
                val canSend = input.isNotBlank() && !working
                Box(
                    Modifier
                        .size(52.dp)
                        .clip(CircleShape)
                        .background(if (working) Mr.Elevated else if (canSend) Mr.BordoLive else Mr.Elevated)
                        .clickable(enabled = working || canSend) { if (working) stop() else send() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (working) Icon(Icons.Default.Close, "Detener", tint = Mr.Glow)
                    else Icon(Icons.AutoMirrored.Filled.Send, "Enviar", tint = if (canSend) Color.White else Mr.TextSoft)
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(m: ChatMessage) {
    when (m.role) {
        "user" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text(
                m.text, color = Color.White, fontSize = 15.sp,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp))
                    .background(Mr.BordoLive)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
        "tool" -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp)) {
            Icon(Icons.Default.Build, null, tint = Mr.BordoBright, modifier = Modifier.size(13.dp))
            Spacer(Modifier.width(6.dp))
            Text(m.text, color = Mr.TextSoft, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        "error" -> Text(m.text, color = Color(0xFFFF8A8A), fontSize = 13.sp, modifier = Modifier.padding(start = 4.dp))
        "info" -> Text(m.text, color = Mr.TextSoft, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp))
        else -> Text(
            cleanMarkdown(m.text), color = Mr.Text, fontSize = 15.sp, lineHeight = 21.sp,
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp))
                .background(Mr.Elevated)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}
