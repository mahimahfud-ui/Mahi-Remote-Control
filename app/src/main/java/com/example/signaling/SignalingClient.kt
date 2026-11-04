package com.example.signaling

import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.BuildConfig
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
import java.util.concurrent.TimeUnit

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    AUTHENTICATED,
    ERROR
}

data class SignalingMessage(
    val type: String, // "REGISTER", "PAIR_REQUEST", "SDP_OFFER", "SDP_ANSWER", "ICE_CANDIDATE", "PING", "PONG"
    val sender: String,
    val recipient: String? = null,
    val payload: String
)

class SignalingClient(
    private val deviceIdentity: DeviceIdentity.Identity,
    private val onMessageReceived: (SignalingMessage) -> Unit
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    @Volatile private var sessionToken: String? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var reconnectJob: Job? = null

    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _serverUrl = MutableStateFlow("")
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private val _runtimeConfigJson = MutableStateFlow<String?>(null)
    val runtimeConfigJson: StateFlow<String?> = _runtimeConfigJson.asStateFlow()
    @Volatile private var configRequestInFlight = false

    fun updateServerUrl(newUrl: String) {
        _serverUrl.value = newUrl
        reconnect()
    }

    fun setSessionToken(token: String?) {
        sessionToken = token?.takeIf { it.isNotBlank() }
        if (sessionToken != null) {
            _connectionStatus.value = ConnectionStatus.AUTHENTICATED
        } else if (_serverUrl.value.isNotBlank() && webSocket != null) {
            _connectionStatus.value = ConnectionStatus.CONNECTED
        }
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
            loadRuntimeConfiguration()
            return
        }
        connectWebSocket()
    }

    private fun loadRuntimeConfiguration() {
        if (configRequestInFlight) return
        val baseUrl = BuildConfig.PUBLIC_BASE_URL.trim().trimEnd('/')
        if (baseUrl.isBlank()) {
            _connectionStatus.value = ConnectionStatus.ERROR
            AuditLogger.log(
                "CONFIG",
                "PUBLIC_BASE_URL_MISSING",
                "Set PUBLIC_BASE_URL in the Android build environment. No default public signaling host is assumed.",
                AuditSeverity.CRITICAL
            )
            return
        }

        configRequestInFlight = true
        _connectionStatus.value = ConnectionStatus.CONNECTING
        val request = try {
            Request.Builder().url("$baseUrl/api/v1/config").get().build()
        } catch (e: Exception) {
            configRequestInFlight = false
            _connectionStatus.value = ConnectionStatus.ERROR
            AuditLogger.log("CONFIG", "INVALID_BASE_URL", "Invalid PUBLIC_BASE_URL: ${e.message}", AuditSeverity.CRITICAL)
            return
        }

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                configRequestInFlight = false
                _connectionStatus.value = ConnectionStatus.ERROR
                AuditLogger.log("CONFIG", "FETCH_FAILED", "Could not load backend runtime configuration: ${e.message}", AuditSeverity.WARNING)
                scheduleConfigRetry()
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use {
                    configRequestInFlight = false
                    val responseText = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        _connectionStatus.value = ConnectionStatus.ERROR
                        AuditLogger.log("CONFIG", "HTTP_ERROR", "Runtime configuration returned HTTP ${it.code}", AuditSeverity.WARNING)
                        return
                    }
                    try {
                        val config = org.json.JSONObject(responseText)
                        val url = config.optString("signalingUrl")
                        if (!url.startsWith("wss://")) {
                            _connectionStatus.value = ConnectionStatus.ERROR
                            AuditLogger.log("CONFIG", "PUBLIC_URL_UNAVAILABLE", "Backend has no configured HTTPS/WSS public URL.", AuditSeverity.CRITICAL)
                            return
                        }
                        _runtimeConfigJson.value = responseText
                        _serverUrl.value = url
                        AuditLogger.log("CONFIG", "LOADED", "Loaded public signaling URL and runtime ICE configuration.", AuditSeverity.INFO)
                        connectWebSocket()
                    } catch (e: Exception) {
                        _connectionStatus.value = ConnectionStatus.ERROR
                        AuditLogger.log("CONFIG", "PARSE_FAILED", "Invalid runtime configuration response: ${e.message}", AuditSeverity.WARNING)
                    }
                }
            }
        })
    }

    private fun scheduleConfigRetry() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(5000L)
            if (isActive && _serverUrl.value.isBlank() && !configRequestInFlight) {
                loadRuntimeConfiguration()
            }
        }
    }

    private fun connectWebSocket() {
        if (_connectionStatus.value == ConnectionStatus.CONNECTING ||
            _connectionStatus.value == ConnectionStatus.CONNECTED ||
            _connectionStatus.value == ConnectionStatus.AUTHENTICATED) {
            return
        }

        _connectionStatus.value = ConnectionStatus.CONNECTING
        AuditLogger.log("SIGNALING", "CONNECTING", "Establishing signaling channel to ${_serverUrl.value} as $currentRole", AuditSeverity.INFO)

        val request = try {
            Request.Builder()
                .url(_serverUrl.value)
                .addHeader("X-Device-Id", deviceIdentity.deviceId)
                .addHeader("X-Device-Fingerprint", deviceIdentity.fingerprint)
                .addHeader("X-Device-Name", deviceIdentity.deviceName)
                .addHeader("X-Client-Role", currentRole)
                .build()
        } catch (e: Exception) {
            _connectionStatus.value = ConnectionStatus.DISCONNECTED
            AuditLogger.log("SIGNALING", "INVALID_URL", "Could not build request for ${_serverUrl.value}: ${e.message}", AuditSeverity.WARNING)
            return
        }

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                _connectionStatus.value = ConnectionStatus.CONNECTED
                AuditLogger.log("SIGNALING", "CONNECTED", "WebSocket transport connected. Session authorization is still required.", AuditSeverity.INFO)
                send("REGISTER", """{"deviceId":"${deviceIdentity.deviceId}","model":"${deviceIdentity.deviceName}"}""")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                parseAndDispatch(text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
                _connectionStatus.value = ConnectionStatus.DISCONNECTED
                AuditLogger.log("SIGNALING", "CLOSING", "Signaling connection closing: $reason", AuditSeverity.INFO)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                _connectionStatus.value = ConnectionStatus.ERROR
                AuditLogger.log("SIGNALING", "ERROR", "Signaling socket error: ${t.message}. Reconnection armed.", AuditSeverity.WARNING)
                scheduleReconnect()
            }
        })
    }

    fun send(type: String, payload: String, recipient: String? = null): Boolean {
        val tokenJson = sessionToken?.let { org.json.JSONObject.quote(it) } ?: "null"
        val json = """
            {
              "type": "$type",
              "sender": "${deviceIdentity.deviceId}",
              "recipient": ${if (recipient != null) org.json.JSONObject.quote(recipient) else "null"},
              "sessionToken": $tokenJson,
              "payload": ${if (payload.startsWith("{") || payload.startsWith("[")) payload else org.json.JSONObject.quote(payload)},
              "timestamp": ${System.currentTimeMillis()}
            }
        """.trimIndent()

        val sent = webSocket?.send(json) ?: false
        if (!sent && _connectionStatus.value == ConnectionStatus.AUTHENTICATED) {
            AuditLogger.log("SIGNALING", "SEND_FAILED", "Failed to dispatch message type $type", AuditSeverity.WARNING)
        }
        return sent
    }

    private fun parseAndDispatch(text: String) {
        // Minimal JSON extraction
        try {
            val type = Regex(""""type"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1) ?: "UNKNOWN"
            val sender = Regex(""""sender"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1) ?: "UNKNOWN"
            val recipient = Regex(""""recipient"\s*:\s*"([^"]+)"""").find(text)?.groupValues?.get(1)
            
            onMessageReceived(SignalingMessage(type, sender, recipient, text))
        } catch (e: Exception) {
            // Log parse issue
        }
    }

    fun fetchSessionIceConfig(
        onSuccess: (String) -> Unit,
        onFailure: (String) -> Unit
    ) {
        val baseUrl = BuildConfig.PUBLIC_BASE_URL.trim().trimEnd('/')
        val token = sessionToken
        if (baseUrl.isBlank() || token.isNullOrBlank()) {
            onFailure("An HTTPS backend URL and approved session token are required.")
            return
        }

        val request = try {
            Request.Builder()
                .url("$baseUrl/api/v1/turn-credentials")
                .header("Authorization", "Bearer $token")
                .get()
                .build()
        } catch (e: Exception) {
            onFailure("Invalid TURN credential endpoint: " + (e.message ?: "unknown error"))
            return
        }

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                onFailure("Could not obtain approved-session ICE configuration: " + (e.message ?: "network error"))
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        onFailure("TURN credential endpoint returned HTTP " + it.code)
                        return
                    }
                    try {
                        val root = org.json.JSONObject(body)
                        val servers = root.optJSONArray("iceServers")
                        if (servers == null || servers.length() == 0) {
                            onFailure("The backend returned no ICE servers.")
                            return
                        }
                        onSuccess(root.toString())
                    } catch (e: Exception) {
                        onFailure("Invalid ICE configuration response: " + (e.message ?: "parse error"))
                    }
                }
            }
        })
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(5000L)
            if (isActive && _connectionStatus.value != ConnectionStatus.AUTHENTICATED) {
                AuditLogger.log("SIGNALING", "RECONNECTING", "Attempting automatic signaling reconnect...", AuditSeverity.INFO)
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
}
