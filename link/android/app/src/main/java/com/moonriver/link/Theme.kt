package com.moonriver.link

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object Mr {
    val Black = Color(0xFF050506)
    val Surface = Color(0xFF0F0E10)
    val Elevated = Color(0xFF19171A)
    val Line = Color(0xFF2A2226)
    val Bordo = Color(0xFF7D1128)
    val BordoLive = Color(0xFFA3183A)
    val BordoBright = Color(0xFFC4234A)
    val BordoDeep = Color(0xFF4A0A17)
    val Glow = Color(0xFFFF7896)
    val Text = Color(0xFFF3ECED)
    val TextSoft = Color(0xFFA2959A)
}

private val scheme = darkColorScheme(
    primary = Mr.BordoLive,
    onPrimary = Color.White,
    primaryContainer = Mr.BordoDeep,
    onPrimaryContainer = Mr.Text,
    secondary = Mr.BordoBright,
    background = Mr.Black,
    onBackground = Mr.Text,
    surface = Mr.Surface,
    onSurface = Mr.Text,
    surfaceVariant = Mr.Elevated,
    onSurfaceVariant = Mr.TextSoft,
    surfaceContainer = Mr.Surface,
    surfaceContainerHigh = Mr.Elevated,
    surfaceContainerHighest = Mr.Elevated,
    outline = Mr.Line,
    outlineVariant = Mr.Line,
    error = Color(0xFFFF6B6B),
)

@Composable
fun MoonriverTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
}
