package com.example.signaling

import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.BuildConfig
import com.example.security.DeviceIdentity
import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.security.SecureRandom
import android.util.Base64
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
    private val context: Context,
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
    private val deviceAuthenticationClient = DeviceAuthenticationClient(context, deviceIdentity, client)
    @Volatile private var deviceAccessToken: String? = null
    @Volatile private var sessionToken: String? = null
    @Volatile private var controllerFingerprint: String? = null
    @Volatile private var deviceAuthInFlight = false
    @Volatile private var explicitDisconnect = false
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
            _connectionStatus.value = if (isReceiverRole() && !deviceAccessToken.isNullOrBlank()) {
                ConnectionStatus.AUTHENTICATED
            } else {
                ConnectionStatus.CONNECTED
            }
        }
    }

    private var currentRole: String = "RECEIVER"

    fun setRole(role: String) {
        if (currentRole != role) {
            currentRole = role
            deviceAccessToken = null
            sessionToken = null
            controllerFingerprint = null
            reconnect()
        }
    }

    private fun isReceiverRole(): Boolean = currentRole.equals("RECEIVER", ignoreCase = true)

    private fun newControllerFingerprint(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(
            bytes,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
    }

    fun connect() {
        explicitDisconnect = false
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
            Request.Builder()
                .url("$baseUrl/api/v1/config")
                .header("X-Mahi-Protocol-Version", "1")
                .header("Accept", "application/json")
                .get()
                .build()
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
                        if (it.header("X-Mahi-Protocol-Version") != "1" ||
                            config.optInt("protocolVersion", -1) != 1) {
                            throw IllegalStateException("Backend did not confirm Mahi Remote protocol version 1.")
                        }
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
        if (explicitDisconnect) return
        if (_connectionStatus.value == ConnectionStatus.CONNECTING ||
            _connectionStatus.value == ConnectionStatus.CONNECTED ||
            _connectionStatus.value == ConnectionStatus.AUTHENTICATED ||
            deviceAuthInFlight) {
            return
        }

        _connectionStatus.value = ConnectionStatus.CONNECTING
        AuditLogger.log("SIGNALING", "CONNECTING", "Establishing protocol-v1 signaling channel as $currentRole", AuditSeverity.INFO)

        if (isReceiverRole()) {
            deviceAuthInFlight = true
            scope.launch {
                try {
                    // Every receiver socket obtains a fresh server challenge proof and short-lived token.
                    val access = deviceAuthenticationClient.authenticate()
                    if (explicitDisconnect) return@launch
                    deviceAccessToken = access.value
                    openWebSocket()
                } catch (error: Exception) {
                    deviceAccessToken = null
                    _connectionStatus.value = ConnectionStatus.ERROR
                    AuditLogger.log(
                        "DEVICE_AUTH",
                        "AUTHENTICATION_FAILED",
                        error.message ?: "Device enrollment/authentication failed closed.",
                        AuditSeverity.CRITICAL
                    )
                    scheduleReconnect()
                } finally {
                    deviceAuthInFlight = false
                }
            }
        } else {
            openWebSocket()
        }
    }

    private fun openWebSocket() {
        val baseUrl = _serverUrl.value
        val request = try {
            val parsedUrl = baseUrl.toHttpUrlOrNull()
                ?: throw IllegalArgumentException("Invalid signaling URL.")
            val requestUrl = if (isReceiverRole()) {
                parsedUrl
            } else {
                val ephemeralFingerprint = newControllerFingerprint()
                controllerFingerprint = ephemeralFingerprint
                parsedUrl.newBuilder()
                    .addQueryParameter("controllerFingerprint", ephemeralFingerprint)
                    .build()
            }

            val builder = Request.Builder()
                .url(requestUrl)
                .header("X-Mahi-Protocol-Version", "1")

            if (isReceiverRole()) {
                val token = deviceAccessToken
                    ?: throw IllegalStateException("Receiver device authentication is required before WSS.")
                builder.header("Authorization", "Bearer $token")
                builder.header("X-Device-Name", deviceIdentity.deviceName)
            }
            builder.build()
        } catch (error: Exception) {
            _connectionStatus.value = ConnectionStatus.ERROR
            AuditLogger.log("SIGNALING", "INVALID_OR_UNAUTHORIZED_SOCKET", error.message ?: "Could not build authenticated WSS request.", AuditSeverity.CRITICAL)
            scheduleReconnect()
            return
        }

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                if (response.header("X-Mahi-Protocol-Version") != "1") {
                    _connectionStatus.value = ConnectionStatus.ERROR
                    ws.close(1002, "Mahi Remote protocol version mismatch")
                    AuditLogger.log("SIGNALING", "PROTOCOL_VERSION_REJECTED", "Backend did not confirm protocol version 1 on WSS.", AuditSeverity.CRITICAL)
                    scheduleReconnect()
                    return
                }

                _connectionStatus.value = if (isReceiverRole() || !sessionToken.isNullOrBlank()) {
                    ConnectionStatus.AUTHENTICATED
                } else {
                    ConnectionStatus.CONNECTED
                }
                AuditLogger.log("SIGNALING", "CONNECTED", "Protocol-v1 WSS transport established.", AuditSeverity.INFO)

                if (isReceiverRole()) {
                    send(
                        "REGISTER",
                        org.json.JSONObject()
                            .put("deviceId", deviceIdentity.deviceId)
                            .put("model", deviceIdentity.deviceName)
                            .toString()
                    )
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                parseAndDispatch(text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
                _connectionStatus.value = ConnectionStatus.DISCONNECTED
                AuditLogger.log("SIGNALING", "CLOSING", "Signaling socket closing ($code): $reason", AuditSeverity.INFO)
                if (!explicitDisconnect) scheduleReconnect()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                _connectionStatus.value = ConnectionStatus.DISCONNECTED
                if (!explicitDisconnect) scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                _connectionStatus.value = ConnectionStatus.ERROR
                if (response?.code == 401 || response?.code == 403 || response?.code == 426) {
                    deviceAccessToken = null
                    sessionToken = null
                }
                AuditLogger.log("SIGNALING", "ERROR", "Protocol-v1 signaling socket failed: ${t.message}. Reauthentication/reconnect armed.", AuditSeverity.WARNING)
                if (!explicitDisconnect) scheduleReconnect()
            }
        })
    }

    fun send(type: String, payload: String, recipient: String? = null): Boolean {
        val tokenJson = sessionToken?.let { org.json.JSONObject.quote(it) } ?: "null"
        val json = """
            {
              "protocolVersion": 1,
              "type": "$type",
              "sender": "${if (isReceiverRole()) deviceIdentity.deviceId else controllerFingerprint.orEmpty()}",
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
                .header("X-Mahi-Protocol-Version", "1")
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
                        if (it.header("X-Mahi-Protocol-Version") != "1" ||
                            root.optInt("protocolVersion", -1) != 1) {
                            onFailure("Backend did not confirm Mahi Remote protocol version 1 for TURN credentials.")
                            return
                        }
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
            if (isActive && !explicitDisconnect &&
                _connectionStatus.value != ConnectionStatus.AUTHENTICATED) {
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
        explicitDisconnect = true
        reconnectJob?.cancel()
        webSocket?.close(1000, "Device disconnecting")
        webSocket = null
        deviceAccessToken = null
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
    }
}
