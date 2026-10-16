package com.moonriver.link

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Tarjeta base: superficie oscura con borde fino. */
@Composable
fun MrCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    padding: Dp = 18.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(22.dp)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Mr.Surface)
            .border(1.dp, Mr.Line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(padding),
        content = content,
    )
}

/** Tarjeta destacada con degradé bordó (estado de la conexión). */
@Composable
fun HeroCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(26.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Brush.linearGradient(listOf(Color(0xFF3A0A15), Color(0xFF16090D), Mr.Surface)))
            .border(1.dp, Color(0xFF4A0A17), shape)
            .padding(22.dp),
        content = content,
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(start = 4.dp, bottom = 10.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), color = Mr.BordoBright, fontSize = 12.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 1.4.sp, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/** Puntito de estado; late suavemente cuando [pulse]. */
@Composable
fun StatusDot(color: Color, pulse: Boolean = false, size: Dp = 10.dp) {
    val alpha = if (pulse) {
        val t = rememberInfiniteTransition(label = "pulse")
        val a by t.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
        a
    } else 1f
    Box(Modifier.size(size).alpha(alpha).clip(CircleShape).background(color))
}

@Composable
fun Pill(text: String, color: Color = Mr.Glow, background: Color = Mr.BordoDeep) {
    Text(
        text, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(background).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

/** Acción cuadrada para la grilla de inicio. */
@Composable
fun ActionTile(icon: ImageVector, title: String, subtitle: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(20.dp)
    Column(
        modifier
            .clip(shape)
            .background(Mr.Surface)
            .border(1.dp, Mr.Line, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.45f)
            .padding(16.dp),
    ) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(Mr.BordoDeep), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Mr.Glow, modifier = Modifier.size(21.dp))
        }
        Spacer(Modifier.padding(top = 14.dp))
        Text(title, color = Mr.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1)
        Text(subtitle, color = Mr.TextSoft, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun ListRow(icon: ImageVector, title: String, subtitle: String? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(Mr.Elevated), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Mr.BordoBright, modifier = Modifier.size(19.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = Mr.Text, fontWeight = FontWeight.Medium)
            subtitle?.let { Text(it, color = Mr.TextSoft, fontSize = 13.sp) }
        }
    }
}

@Composable
fun SettingSwitch(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Mr.Text, fontWeight = FontWeight.Medium)
            Text(subtitle, color = Mr.TextSoft, fontSize = 13.sp)
        }
        Switch(
            checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White, checkedTrackColor = Mr.BordoLive,
                uncheckedTrackColor = Mr.Elevated, uncheckedBorderColor = Mr.Line, uncheckedThumbColor = Mr.TextSoft,
            ),
        )
    }
}

@Composable
fun MrButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick, enabled = enabled, shape = RoundedCornerShape(14.dp), modifier = modifier,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Mr.BordoLive, contentColor = Color.White,
            disabledContainerColor = Mr.Elevated, disabledContentColor = Mr.TextSoft,
        ),
    ) { Text(text, fontWeight = FontWeight.SemiBold) }
}

@Composable
fun MrTextField(
    value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier,
    keyboard: KeyboardType = KeyboardType.Text, big: Boolean = false, singleLine: Boolean = true, maxLines: Int = 1,
) {
    OutlinedTextField(
        value = value, onValueChange = onChange, modifier = modifier, singleLine = singleLine, maxLines = maxLines,
        placeholder = { Text(placeholder, color = Mr.TextSoft.copy(alpha = 0.55f)) },
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        textStyle = MaterialTheme.typography.bodyLarge.copy(
            color = Mr.Text,
            fontSize = if (big) 28.sp else 16.sp,
            letterSpacing = if (big) 8.sp else 0.sp,
            textAlign = if (big) TextAlign.Center else TextAlign.Start,
            fontWeight = if (big) FontWeight.Bold else FontWeight.Normal,
        ),
        shape = RoundedCornerShape(16.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Mr.BordoLive, unfocusedBorderColor = Mr.Line,
            focusedContainerColor = Mr.Elevated, unfocusedContainerColor = Mr.Elevated,
            cursorColor = Mr.BordoBright,
        ),
    )
}

@Composable
fun EmptyState(text: String) {
    Text(text, color = Mr.TextSoft, fontSize = 14.sp, modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp))
}

val ScreenPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp)
val Gap = Arrangement.spacedBy(14.dp)
