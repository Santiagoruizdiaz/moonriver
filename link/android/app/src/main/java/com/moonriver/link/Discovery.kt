package com.moonriver.link

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

data class PcInfo(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val fingerprint: String,
)

/**
 * Busca PCs Moonriver en la red: manda "MOONRIVER?" por broadcast y junta las respuestas
 * (llegan directo a nuestro socket, así que no hace falta multicast lock).
 */
object Discovery {
    const val PORT = 41821

    suspend fun scan(context: Context, timeoutMs: Int = 1500): List<PcInfo> = withContext(Dispatchers.IO) {
        val found = linkedMapOf<String, PcInfo>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val probe = "MOONRIVER?".toByteArray()
            val targets = buildList {
                broadcastAddress(context)?.let { add(it) }
                add(InetAddress.getByName("255.255.255.255"))
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            var lastProbe = 0L
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                if (System.currentTimeMillis() - lastProbe > 500) {
                    for (t in targets) runCatching { socket.send(DatagramPacket(probe, probe.size, t, PORT)) }
                    lastProbe = System.currentTimeMillis()
                }
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val json = JSONObject(String(packet.data, 0, packet.length))
                    if (json.optInt("moonriver") >= 1) {
                        val info = PcInfo(
                            id = json.getString("id"),
                            name = json.getString("name"),
                            host = packet.address.hostAddress ?: continue,
                            port = json.getInt("port"),
                            fingerprint = json.getString("fingerprint"),
                        )
                        found[info.id] = info
                    }
                } catch (_: SocketTimeoutException) {
                } catch (_: Exception) {
                }
            }
        }
        found.values.toList()
    }

    @Suppress("DEPRECATION")
    private fun broadcastAddress(context: Context): InetAddress? {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val dhcp = wifi.dhcpInfo ?: return null
        if (dhcp.ipAddress == 0) return null
        val broadcast = (dhcp.ipAddress and dhcp.netmask) or dhcp.netmask.inv()
        val bytes = ByteArray(4) { i -> (broadcast shr (i * 8) and 0xFF).toByte() }
        return InetAddress.getByAddress(bytes)
    }
}
