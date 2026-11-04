package com.example.signaling

import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.security.DeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.TimeUnit

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    AUTHENTICATED,
    ERROR
}

data class SignalingMessage(
    val type: String,
    val sender: String,
    val recipient: String? = null,
    val payload: String
)

class SignalingClient(
    private val deviceIdentity: DeviceIdentity.Identity,
    private val onMessageReceived: (SignalingMessage) -> Unit
) {
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var reconnectJob: Job? = null
    @Volatile private var sessionToken: String? = null

    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _serverUrl = MutableStateFlow("")
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    fun updateServerUrl(newUrl: String) {
        _serverUrl.value = newUrl
        reconnect()
    }

    private var currentRole: String = "RECEIVER"

    fun setRole(role: String) {
        if (currentRole != role) {
            currentRole = role
            reconnect()
        }
    }

    fun connect() {
        if (_serverUrl.value.isBlank()) {
            _connectionStatus.value = ConnectionStatus.ERROR
            AuditLogger.log(
                "SIGNALING", "SERVER_NOT_CONFIGURED",
                "Set MAHI_PUBLIC_BASE_URL at Android build time to enable public remote access.",
                AuditSeverity.WARNING
            )
            return
        }
        if (_connectionStatus.value == ConnectionStatus.CONNECTING ||
            _connectionStatus.value == ConnectionStatus.CONNECTED ||
            _connectionStatus.value == ConnectionStatus.AUTHENTICATED) return

        _connectionStatus.value = ConnectionStatus.CONNECTING
        AuditLogger.log(
            "SIGNALING", "CONNECTING",
            "Connecting to " + _serverUrl.value + " as " + currentRole,
            AuditSeverity.INFO
        )

        val request = try {
            Request.Builder()
                .url(_serverUrl.value)
                .addHeader("X-Device-Id", deviceIdentity.deviceId)
                .addHeader("X-Device-Fingerprint", deviceIdentity.fingerprint)
                .addHeader("X-Device-Name", deviceIdentity.deviceName)
                .addHeader("X-Client-Role", currentRole)
                .apply {
                    sessionToken?.takeIf { it.isNotBlank() }?.let {
                        addHeader("Authorization", "Bearer " + it)
                    }
                }
                .build()
        } catch (e: Exception) {
            _connectionStatus.value = ConnectionStatus.DISCONNECTED
            AuditLogger.log("SIGNALING", "INVALID_URL", "Invalid signaling URL: " + e.message, AuditSeverity.WARNING)
            return
        }

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                _connectionStatus.value = ConnectionStatus.AUTHENTICATED
                AuditLogger.log("SIGNALING", "CONNECTED", "Secure signaling socket opened", AuditSeverity.INFO)
                send(
                    "REGISTER",
                    JSONObject()
                        .put("deviceId", deviceIdentity.deviceId)
                        .put("model", deviceIdentity.deviceName)
                        .toString()
                )
            }

            override fun onMessage(ws: WebSocket, text: String) {
                parseAndDispatch(text)
                try {
                    val message = JSONObject(text)
                    when (message.optString("type")) {
                        "SESSION_AUTHORIZED" -> {
                            val nextToken = message.optString("sessionToken")
                            if (nextToken.isNotBlank() && nextToken != sessionToken) {
                                sessionToken = nextToken
                                reconnectJob?.cancel()
                                reconnectJob = scope.launch {
                                    delay(250)
                                    reconnect()
                                }
                            }
                        }
                        "SESSION_REVOKED", "AUTHENTICATION_FAILED", "DISCONNECTED" -> {
                            sessionToken = null
                        }
                    }
                } catch (_: Exception) {
                    // Other signaling messages are parsed by the application callback.
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
                _connectionStatus.value = ConnectionStatus.DISCONNECTED
                AuditLogger.log("SIGNALING", "CLOSING", "Signaling connection closing: " + reason, AuditSeverity.INFO)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                _connectionStatus.value = ConnectionStatus.ERROR
                AuditLogger.log("SIGNALING", "ERROR", "Signaling socket error: " + t.message, AuditSeverity.WARNING)
                scheduleReconnect()
            }
        })
    }

    fun send(type: String, payload: String, recipient: String? = null): Boolean {
        val payloadValue = try {
            JSONTokener(payload).nextValue()
        } catch (_: Exception) {
            payload
        }
        val json = JSONObject()
            .put("type", type)
            .put("sender", deviceIdentity.deviceId)
            .put("recipient", recipient)
            .put("payload", payloadValue)
            .put("timestamp", System.currentTimeMillis())
            .toString()

        val sent = webSocket?.send(json) ?: false
        if (!sent && _connectionStatus.value == ConnectionStatus.AUTHENTICATED) {
            AuditLogger.log("SIGNALING", "SEND_FAILED", "Failed to send message type " + type, AuditSeverity.WARNING)
        }
        return sent
    }

    private fun parseAndDispatch(text: String) {
        try {
            val root = JSONObject(text)
            val type = root.optString("type", "UNKNOWN")
            val sender = root.optString("sender", root.optString("senderId", "UNKNOWN"))
            val recipient = root.optString("recipient").takeIf { it.isNotBlank() }
            onMessageReceived(SignalingMessage(type, sender, recipient, text))
        } catch (e: Exception) {
            AuditLogger.log("SIGNALING", "PARSE_ERROR", "Invalid signaling response received", AuditSeverity.WARNING)
        }
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(5000L)
            if (isActive && _connectionStatus.value != ConnectionStatus.AUTHENTICATED) {
                AuditLogger.log("SIGNALING", "RECONNECTING", "Attempting signaling reconnect", AuditSeverity.INFO)
                connect()
            }
        }
    }

    fun reconnect() {
        disconnect()
        connect()
    }

    fun disconnect() {
        reconnectJob?.cancel()
        webSocket?.close(1000, "Device disconnecting")
        webSocket = null
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
    }

    fun clearSessionToken() {
        sessionToken = null
        reconnect()
    }
}
