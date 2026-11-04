package com.example.ui

import android.app.Application
import com.example.BuildConfig
import android.content.Context
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.appmanager.AppItem
import com.example.appmanager.AppManager
import com.example.controller.AppRole
import com.example.controller.ControllerSession
import com.example.controller.KnownTargetDevice
import com.example.controller.RemoteTelemetry
import com.example.controller.RemoteViewerTab
import com.example.diagnostics.DiagnosticItem
import com.example.diagnostics.DiagnosticsManager
import com.example.filetransfer.FileEntry
import com.example.filetransfer.FileManager
import com.example.pairing.OperatorRequest
import com.example.pairing.PairingManager
import com.example.remoteinput.MahiAccessibilityService
import com.example.remotescreen.AndroidWebRtcSession
import com.example.remotescreen.ScreenCaptureService
import com.example.remotescreen.ScreenStreamState
import com.example.remotescreen.StreamMetrics
import com.example.remotescreen.VideoPreset
import com.example.rootintegration.RootDetector
import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.security.DeviceIdentity
import com.example.signaling.ConnectionStatus
import com.example.signaling.SignalingClient
import com.example.signaling.SignalingMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection
import org.webrtc.VideoTrack
import java.util.UUID
import java.net.HttpURLConnection
import java.net.URL

enum class MainTab(val title: String) {
    DASHBOARD("Dashboard"),
    PAIRING("Pairing"),
    SERVICES("Services"),
    DIAGNOSTICS("Diagnostics"),
    FILES("Files"),
    APPS("Apps"),
    AUDIT("Security Logs")
}

class MahiViewModel(application: Application) : AndroidViewModel(application) {

    val identity = DeviceIdentity.getOrCreateIdentity(application)
    val pairingManager = PairingManager(application)
    val diagnosticsManager = DiagnosticsManager(application)
    val fileManager = FileManager(application)
    val appManager = AppManager(application)
    val rootDetector = RootDetector(application)

    // Role state: Receiver (default) or Controller
    private val _appRole = MutableStateFlow(AppRole.RECEIVER)
    val appRole: StateFlow<AppRole> = _appRole.asStateFlow()

    // Receiver state
    private val _selectedTab = MutableStateFlow(MainTab.DASHBOARD)
    val selectedTab: StateFlow<MainTab> = _selectedTab.asStateFlow()

    private val _showQrDialog = MutableStateFlow(false)
    val showQrDialog: StateFlow<Boolean> = _showQrDialog.asStateFlow()

    private val _showDisconnectDialog = MutableStateFlow(false)
    val showDisconnectDialog: StateFlow<Boolean> = _showDisconnectDialog.asStateFlow()

    private val _videoPreset = MutableStateFlow(VideoPreset.BALANCED)
    val videoPreset: StateFlow<VideoPreset> = _videoPreset.asStateFlow()

    private val _currentBrowsingPath = MutableStateFlow(application.filesDir.absolutePath)
    val currentBrowsingPath: StateFlow<String> = _currentBrowsingPath.asStateFlow()

    private val _currentFileList = MutableStateFlow<List<FileEntry>>(emptyList())
    val currentFileList: StateFlow<List<FileEntry>> = _currentFileList.asStateFlow()

    private val _installedApps = MutableStateFlow<List<AppItem>>(emptyList())
    val installedApps: StateFlow<List<AppItem>> = _installedApps.asStateFlow()

    private val _appSearchQuery = MutableStateFlow("")
    val appSearchQuery: StateFlow<String> = _appSearchQuery.asStateFlow()

    private val _isDiagnosticsRunning = MutableStateFlow(false)
    val isDiagnosticsRunning: StateFlow<Boolean> = _isDiagnosticsRunning.asStateFlow()

    val screenStreamState: StateFlow<ScreenStreamState> = ScreenCaptureService.streamState
    val auditEvents = AuditLogger.events

    private val _browserAccessUrl = MutableStateFlow<String?>(null)
    val browserAccessUrl: StateFlow<String?> = _browserAccessUrl.asStateFlow()

    private val _publicBackendStatus = MutableStateFlow("Public backend is not configured for this build.")
    val publicBackendStatus: StateFlow<String> = _publicBackendStatus.asStateFlow()

    // Controller Mode State
    private val _isControllerConnecting = MutableStateFlow(false)
    val isControllerConnecting: StateFlow<Boolean> = _isControllerConnecting.asStateFlow()

    private val _controllerErrorMessage = MutableStateFlow<String?>(null)
    val controllerErrorMessage: StateFlow<String?> = _controllerErrorMessage.asStateFlow()

    private val _activeControllerSession = MutableStateFlow<ControllerSession?>(null)
    val activeControllerSession: StateFlow<ControllerSession?> = _activeControllerSession.asStateFlow()

    private val _recentTargetDevices = MutableStateFlow<List<KnownTargetDevice>>(emptyList())
    val recentTargetDevices: StateFlow<List<KnownTargetDevice>> = _recentTargetDevices.asStateFlow()

    private val _remoteViewerTab = MutableStateFlow(RemoteViewerTab.SCREEN)
    val remoteViewerTab: StateFlow<RemoteViewerTab> = _remoteViewerTab.asStateFlow()

    private val _remoteFileList = MutableStateFlow<List<FileEntry>>(emptyList())
    val remoteFileList: StateFlow<List<FileEntry>> = _remoteFileList.asStateFlow()

    private val _remoteAppList = MutableStateFlow<List<AppItem>>(emptyList())
    val remoteAppList: StateFlow<List<AppItem>> = _remoteAppList.asStateFlow()

    private val _remoteTelemetry = MutableStateFlow<RemoteTelemetry?>(null)
    val remoteTelemetry: StateFlow<RemoteTelemetry?> = _remoteTelemetry.asStateFlow()

    private val _remoteMetrics = MutableStateFlow(StreamMetrics())
    val remoteMetrics: StateFlow<StreamMetrics> = _remoteMetrics.asStateFlow()

    val remoteWebRtcSession: AndroidWebRtcSession
    val remoteVideoTrack: StateFlow<VideoTrack?> get() = remoteWebRtcSession.remoteVideo
    val remoteWebRtcStatus: StateFlow<String> get() = remoteWebRtcSession.status

    val signalingClient: SignalingClient

    init {
        signalingClient = SignalingClient(identity) { msg ->
            handleIncomingSignalingMessage(msg)
        }
        remoteWebRtcSession = AndroidWebRtcSession(application) { type, payload, recipient ->
            signalingClient.send(type, payload, recipient)
        }
        loadPublicBackendConfig()

        // Register the current receiver code after every successful signaling connection.
        // This also covers reconnects and code rotation; sending before WebSocket onOpen loses the packet.
        viewModelScope.launch {
            combine(signalingClient.connectionStatus, pairingManager.currentPairingCode, appRole) { status, code, role ->
                if (status == ConnectionStatus.AUTHENTICATED &&
                    role == AppRole.RECEIVER &&
                    pairingManager.activeSession.value == null
                ) code else null
            }.collect { code ->
                code?.let { activeCode ->
                    signalingClient.send(
                        "REGISTER_PAIRING_CODE",
                        """{"code":"${activeCode.code}","expiresAt":${activeCode.expiresAtMillis}}"""
                    )
                }
            }
        }

        refreshFiles()
        refreshApps()

        viewModelScope.launch {
            runDiagnostics()
        }
    }

    private suspend fun fetchIceServers(token: String): List<PeerConnection.IceServer> = withContext(Dispatchers.IO) {
        val servers = mutableListOf(
            PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )
        val base = BuildConfig.MAHI_PUBLIC_BASE_URL.trim().trimEnd('/')
        if (base.isBlank() || token.isBlank()) return@withContext servers
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(base + "/api/v1/turn/credentials").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 8000
                doOutput = true
                setRequestProperty("Authorization", "Bearer " + token)
                setRequestProperty("Content-Type", "application/json")
            }
            connection.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
            if (connection.responseCode !in 200..299) return@withContext servers
            val response = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            val array = response.optJSONArray("iceServers") ?: return@withContext servers
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val urlsValue = item.opt("urls")
                val urls = when (urlsValue) {
                    is JSONArray -> (0 until urlsValue.length()).mapNotNull { urlsValue.optString(it).takeIf(String::isNotBlank) }
                    is String -> listOf(urlsValue).filter(String::isNotBlank)
                    else -> emptyList()
                }
                if (urls.isEmpty()) continue
                val builder = PeerConnection.IceServer.builder(urls)
                item.optString("username").takeIf(String::isNotBlank)?.let(builder::setUsername)
                item.optString("credential").takeIf(String::isNotBlank)?.let(builder::setPassword)
                servers.add(builder.createIceServer())
            }
        } catch (_: Exception) {
            AuditLogger.log("WEBRTC", "TURN_UNAVAILABLE", "Using STUN-only connectivity; relay credentials are unavailable", AuditSeverity.WARNING)
        } finally {
            connection?.disconnect()
        }
        servers
    }

    private fun loadPublicBackendConfig() {
        val baseUrl = BuildConfig.MAHI_PUBLIC_BASE_URL.trim().trimEnd('/')
        if (!baseUrl.startsWith("https://", ignoreCase = true)) {
            _publicBackendStatus.value = "Browser access is disabled. Build with MAHI_PUBLIC_BASE_URL=https://your-domain."
            return
        }

        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val connection = (URL(baseUrl + "/api/v1/config").openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 8000
                        readTimeout = 8000
                        setRequestProperty("Accept", "application/json")
                    }
                    try {
                        if (connection.responseCode !in 200..299) {
                            throw IllegalStateException("Backend configuration returned HTTP " + connection.responseCode)
                        }
                        JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                    } finally {
                        connection.disconnect()
                    }
                }

                if (!result.optBoolean("publicAccessConfigured")) {
                    _publicBackendStatus.value = result.optString(
                        "message",
                        "Backend has not enabled public browser access."
                    )
                    return@launch
                }

                val browserUrl = result.optString("browserUrl")
                val signalingUrl = result.optString("signalingUrl")
                if (!browserUrl.startsWith("https://") || !signalingUrl.startsWith("wss://")) {
                    throw IllegalStateException("Backend returned invalid public HTTPS/WSS URLs.")
                }

                _browserAccessUrl.value = browserUrl
                _publicBackendStatus.value = if (result.optBoolean("turnConfigured")) {
                    "Public access configured. TURN credentials endpoint is available."
                } else {
                    "Public signaling configured. TURN relay is not configured; some mobile networks may not connect."
                }
                signalingClient.updateServerUrl(signalingUrl)
            } catch (error: Exception) {
                _publicBackendStatus.value = "Backend configuration unavailable: " + (error.message ?: "network error")
                AuditLogger.log("CONFIG", "PUBLIC_CONFIG_ERROR", error.message ?: "Could not load public backend configuration", AuditSeverity.WARNING)
            }
        }
    }
    private fun handleIncomingSignalingMessage(msg: SignalingMessage) {
        viewModelScope.launch {
            try {
                when (msg.type) {
                    "PAIR_REQUEST" -> {
                        val envelope = JSONObject(msg.payload)
                        val root = envelope.optJSONObject("payload") ?: envelope
                        val opName = envelope.optString("operatorName",
                            root.optString("operatorName", envelope.optString("controllerName", root.optString("controllerName", "Remote controller"))))
                        val opLoc = envelope.optString("operatorLocation", root.optString("operatorLocation", "Remote controller"))
                        val opFp = envelope.optString("fingerprint",
                            root.optString("fingerprint", envelope.optString("controllerFingerprint", "UNKNOWN-FP")))
                        val cId = envelope.optString("controllerId", root.optString("controllerId", msg.sender))
                        val scopesJson = envelope.optJSONArray("requestedScopes") ?: root.optJSONArray("requestedScopes")
                        val scopes = mutableListOf<String>()
                        if (scopesJson != null) {
                            for (i in 0 until scopesJson.length()) scopes.add(scopesJson.getString(i))
                        } else {
                            scopes.addAll(listOf("Screen Mirroring", "Remote Interaction"))
                        }
                        pairingManager.recordIncomingOperatorRequest(
                            controllerId = cId,
                            operatorName = opName,
                            location = opLoc,
                            fingerprint = opFp,
                            scopes = scopes
                        )
                    }
                    "PAIR_ACCEPT" -> {
                        // This confirms receiver approval; the server sends a separate session token.
                        val envelope = JSONObject(msg.payload)
                        val root = envelope.optJSONObject("payload") ?: envelope
                        val sessionId = root.optString("sessionId", "")
                        val receiverName = root.optString("receiverName", "Android Receiver")
                        val targetFp = root.optString("fingerprint", "")
                        _activeControllerSession.value = ControllerSession(
                            sessionId = sessionId,
                            targetDeviceId = msg.sender,
                            targetDeviceName = receiverName,
                            targetFingerprint = targetFp,
                            sessionToken = "",
                            connectedAtMillis = System.currentTimeMillis()
                        )
                        _isControllerConnecting.value = true
                        _controllerErrorMessage.value = "Approved. Authenticating secure session…"

                        val updated = _recentTargetDevices.value.filter { it.deviceId != msg.sender } +
                            KnownTargetDevice(
                                deviceId = msg.sender,
                                name = receiverName,
                                model = "Android Device",
                                fingerprint = targetFp,
                                lastConnectedAtMillis = System.currentTimeMillis(),
                                isOnline = true
                            )
                        _recentTargetDevices.value = updated
                    }
                    "SESSION_AUTHORIZED" -> {
                        val envelope = JSONObject(msg.payload)
                        val sessionId = envelope.optString("sessionId", "")
                        val token = envelope.optString("sessionToken", "")
                        if (token.isNotBlank() && sessionId.isNotBlank()) {
                            val controllerSession = _activeControllerSession.value
                            viewModelScope.launch {
                                val iceServers = fetchIceServers(token)
                                if (controllerSession != null && appRole.value == AppRole.CONTROLLER) {
                                    val authenticated = controllerSession.copy(sessionId = sessionId, sessionToken = token)
                                    _activeControllerSession.value = authenticated
                                    _isControllerConnecting.value = false
                                    _controllerErrorMessage.value = null
                                    remoteWebRtcSession.startController(sessionId, authenticated.targetDeviceId, iceServers)
                                    AuditLogger.log("CONTROLLER", "SESSION_AUTHENTICATED", "Approved session authenticated; starting video negotiation", AuditSeverity.SECURITY)
                                } else {
                                    remoteWebRtcSession.setIceServers(iceServers)
                                    AuditLogger.log("RECEIVER", "SESSION_AUTHENTICATED", "Approved controller session authenticated", AuditSeverity.SECURITY)
                                }
                            }
                        }
                    }
                    "SDP_OFFER", "SDP_ANSWER", "ICE_CANDIDATE", "STREAM_STATUS" -> {
                        val envelope = JSONObject(msg.payload)
                        remoteWebRtcSession.onSignal(msg.type, msg.sender, envelope.optString("sessionId", ""), messagePayload(msg))
                    }
                    "SESSION_REVOKED", "DISCONNECTED" -> {
                        val receiverWasSharing = appRole.value == AppRole.RECEIVER && ScreenCaptureService.isStreaming()
                        remoteWebRtcSession.endFromServer()
                        if (appRole.value == AppRole.RECEIVER) {
                            pairingManager.emergencyDisconnect("The approved remote session was revoked by a participant")
                            if (receiverWasSharing) {
                                ScreenCaptureService.stopAfterSessionRevoked(getApplication())
                            }
                        }
                        _activeControllerSession.value = null
                        _isControllerConnecting.value = false
                        _controllerErrorMessage.value = "Remote session was disconnected."
                    }
                    "PAIR_REJECT" -> {
                        _isControllerConnecting.value = false
                        _controllerErrorMessage.value = "Remote phone denied the connection request."
                        AuditLogger.log("CONTROLLER", "SESSION_DENIED", "Target phone rejected pairing request", AuditSeverity.WARNING)
                    }
                    "PAIR_ERROR" -> {
                        val root = JSONObject(msg.payload)
                        _isControllerConnecting.value = false
                        _controllerErrorMessage.value = root.optString("error", "Pairing error occurred.")
                    }
                    "SCOPE_REQUIRED" -> {
                        val root = JSONObject(msg.payload)
                        _controllerErrorMessage.value = root.optString(
                            "error",
                            "The receiver did not approve: " + root.optString("requiredScope", "requested permission")
                        )
                    }
                    "APP_LIST_RESPONSE" -> {
                        val envelope = JSONObject(msg.payload)
                        val payloadObject = envelope.optJSONObject("payload")
                        val raw = envelope.optString("payload", "")
                        val jsonArr = payloadObject?.optJSONArray("apps")
                            ?: envelope.optJSONArray("apps")
                            ?: envelope.optJSONArray("payload")
                            ?: if (raw.startsWith("[")) JSONArray(raw) else JSONArray()
                        val list = mutableListOf<AppItem>()
                        for (i in 0 until jsonArr.length()) {
                            val obj = jsonArr.getJSONObject(i)
                            list.add(
                                AppItem(
                                    packageName = obj.optString("pkg", obj.optString("packageName")),
                                    appName = obj.optString("name", obj.optString("appName")),
                                    versionName = obj.optString("ver", "1.0"),
                                    versionCode = 1L,
                                    isSystemApp = false,
                                    targetSdk = 34
                                )
                            )
                        }
                        _remoteAppList.value = list
                    }
                    "FILE_LIST_RESPONSE" -> {
                        val envelope = JSONObject(msg.payload)
                        val payloadObject = envelope.optJSONObject("payload")
                        val raw = envelope.optString("payload", "")
                        val jsonArr = payloadObject?.optJSONArray("files")
                            ?: envelope.optJSONArray("files")
                            ?: envelope.optJSONArray("payload")
                            ?: if (raw.startsWith("[")) JSONArray(raw) else JSONArray()
                        val list = mutableListOf<FileEntry>()
                        for (i in 0 until jsonArr.length()) {
                            val obj = jsonArr.getJSONObject(i)
                            val size = obj.optLong("size", 0L)
                            list.add(
                                FileEntry(
                                    name = obj.optString("name"),
                                    path = obj.optString("path"),
                                    sizeBytes = size,
                                    formattedSize = if (size > 1048576) "${size / 1048576} MB" else "${size / 1024} KB",
                                    isDirectory = obj.optBoolean("isDir"),
                                    lastModified = "Just now",
                                    mimeType = if (obj.optBoolean("isDir")) "inode/directory" else "application/octet-stream"
                                )
                            )
                        }
                        _remoteFileList.value = list
                    }
                    "DIAGNOSTICS_RESULT" -> {
                        val payloadObj = messagePayload(msg)
                        val battery = payloadObj.optInt("battery", 0)
                        val temp = payloadObj.optDouble("temp", 0.0).toFloat()
                        val storage = payloadObj.optString("storage", "unavailable")
                        _remoteTelemetry.value = RemoteTelemetry(
                            batteryPercent = battery,
                            batteryTempC = temp,
                            storageFree = storage,
                            roundTripTimeMs = 0
                        )
                    }
                    "INPUT_EVENT" -> {
                        handleInputEvent(msg)
                    }
                    "APP_COMMAND" -> {
                        handleAppCommand(msg)
                    }
                    "FILE_COMMAND" -> {
                        handleFileCommand(msg)
                    }
                    "DIAGNOSTICS_RUN" -> {
                        runDiagnostics()
                        val telemetry = diagnosticsManager.telemetry.value
                        signalingClient.send(
                            "DIAGNOSTICS_RESULT",
                            """{"battery":${telemetry.batteryPercent},"temp":${telemetry.batteryTempC},"storage":"${telemetry.freeStorageGb}GB"}""",
                            msg.sender
                        )
                    }
                    "EMERGENCY_DISCONNECT" -> {
                        if (_activeControllerSession.value != null) {
                            disconnectControllerSession()
                        } else {
                            emergencyDisconnect()
                        }
                    }
                }
            } catch (e: Exception) {
                AuditLogger.log("PROTOCOL", "DISPATCH_ERROR", "Error parsing remote message: ${e.message}", AuditSeverity.WARNING)
            }
        }
    }

    private fun messagePayload(msg: SignalingMessage): JSONObject {
        val envelope = JSONObject(msg.payload)
        return envelope.optJSONObject("payload") ?: envelope
    }

    private fun handleInputEvent(msg: SignalingMessage) {
        if (ScreenCaptureService.streamState.value !is ScreenStreamState.Active) {
            AuditLogger.log("INPUT", "BLOCKED_NO_ACTIVE_SCREEN", "Remote input ignored until the receiver has an active, owner-approved screen stream", AuditSeverity.WARNING)
            return
        }
        val root = messagePayload(msg)
        val cmd = if (root.has("command")) root.getJSONObject("command") else root
        val type = cmd.optString("type", "")

        val display = getApplication<Application>().resources.displayMetrics
        val screenW = display.widthPixels.coerceAtLeast(1)
        val screenH = display.heightPixels.coerceAtLeast(1)
        fun mapX(value: Float) = (value / 1080f * screenW).coerceIn(0f, (screenW - 1).toFloat())
        fun mapY(value: Float) = (value / 1920f * screenH).coerceIn(0f, (screenH - 1).toFloat())

        when (type.uppercase()) {
            "TAP" -> {
                val x = mapX(cmd.optDouble("x", -1.0).toFloat())
                val y = mapY(cmd.optDouble("y", -1.0).toFloat())
                MahiAccessibilityService.performTap(x, y, screenW, screenH)
            }
            "DOUBLETAP", "DOUBLE_TAP" -> {
                val x = mapX(cmd.optDouble("x", -1.0).toFloat())
                val y = mapY(cmd.optDouble("y", -1.0).toFloat())
                MahiAccessibilityService.performDoubleTap(x, y, screenW, screenH)
            }
            "LONGPRESS", "LONG_PRESS" -> {
                val x = mapX(cmd.optDouble("x", -1.0).toFloat())
                val y = mapY(cmd.optDouble("y", -1.0).toFloat())
                MahiAccessibilityService.performLongPress(x, y, screenW, screenH)
            }
            "SWIPE" -> {
                val x1 = mapX(cmd.optDouble("x", -1.0).toFloat())
                val y1 = mapY(cmd.optDouble("y", -1.0).toFloat())
                val x2 = mapX(cmd.optDouble("x2", -1.0).toFloat())
                val y2 = mapY(cmd.optDouble("y2", -1.0).toFloat())
                val duration = cmd.optLong("durationMs", 300L)
                MahiAccessibilityService.performSwipe(x1, y1, x2, y2, duration, screenW, screenH)
            }
            "DRAG" -> {
                val x1 = mapX(cmd.optDouble("x", -1.0).toFloat())
                val y1 = mapY(cmd.optDouble("y", -1.0).toFloat())
                val x2 = mapX(cmd.optDouble("x2", -1.0).toFloat())
                val y2 = mapY(cmd.optDouble("y2", -1.0).toFloat())
                val duration = cmd.optLong("durationMs", 600L)
                MahiAccessibilityService.performDrag(x1, y1, x2, y2, duration, screenW, screenH)
            }
            "SCROLL" -> {
                val action = cmd.optString("action", "DOWN")
                val startY = mapY(if (action.equals("UP", ignoreCase = true)) 1400f else 600f)
                val endY = mapY(if (action.equals("UP", ignoreCase = true)) 600f else 1400f)
                val centerX = mapX(540f)
                MahiAccessibilityService.performSwipe(centerX, startY, centerX, endY, 250L, screenW, screenH)
            }
            "GLOBALACTION", "GLOBAL_ACTION" -> {
                val action = cmd.optString("action", "BACK")
                MahiAccessibilityService.performGlobal(action)
            }
            "TEXTINPUT", "TEXT_INPUT" -> {
                val text = cmd.optString("text", "")
                MahiAccessibilityService.performTextInput(text)
            }
            "VOLUME" -> {
                val dir = cmd.optString("action", "UP")
                MahiAccessibilityService.adjustVolume(dir, getApplication())
            }
        }
    }

    private fun handleAppCommand(msg: SignalingMessage) {
        val root = messagePayload(msg)
        val action = root.optString("action", "LIST")
        val pkg = root.optString("packageName", "")

        when (action.uppercase()) {
            "LIST" -> {
                val response = JSONArray()
                appManager.getInstalledApps(false).take(50).forEach { app ->
                    response.put(
                        JSONObject()
                            .put("name", app.appName)
                            .put("pkg", app.packageName)
                            .put("ver", app.versionName)
                    )
                }
                signalingClient.send("APP_LIST_RESPONSE", JSONObject().put("apps", response).toString(), msg.sender)
            }
            "LAUNCH" -> {
                if (pkg.isNotEmpty()) appManager.launchApp(pkg)
            }
            "SETTINGS" -> {
                if (pkg.isNotEmpty()) appManager.openAppSettings(pkg)
            }
            "UNINSTALL" -> {
                if (pkg.isNotEmpty()) appManager.requestUninstall(pkg)
            }
        }
    }

    private fun handleFileCommand(msg: SignalingMessage) {
        val root = messagePayload(msg)
        val action = root.optString("action", "LIST")
        val path = root.optString("path", getApplication<Application>().filesDir.absolutePath)

        when (action.uppercase()) {
            "LIST" -> {
                val response = JSONArray()
                fileManager.listFiles(path).forEach { file ->
                    response.put(
                        JSONObject()
                            .put("name", file.name)
                            .put("path", file.path)
                            .put("isDir", file.isDirectory)
                            .put("size", file.sizeBytes)
                            .put("mimeType", file.mimeType)
                    )
                }
                signalingClient.send("FILE_LIST_RESPONSE", JSONObject().put("files", response).toString(), msg.sender)
            }
            "DELETE" -> {
                val success = fileManager.deleteFile(path, true)
                signalingClient.send(
                    "COMMAND_ACK",
                    JSONObject().put("command", "DELETE").put("success", success).toString(),
                    msg.sender
                )
                if (success) refreshFiles()
            }
            "CREATE_FOLDER" -> {
                val name = root.optString("name", "NewFolder")
                val success = fileManager.createFolder(path, name)
                signalingClient.send(
                    "COMMAND_ACK",
                    JSONObject().put("command", "CREATE_FOLDER").put("success", success).toString(),
                    msg.sender
                )
                if (success) refreshFiles()
            }
            "READ_CHUNK" -> {
                val offset = root.optLong("offset", 0L)
                val length = root.optInt("length", 32768)
                val bytes = fileManager.readFileChunk(path, offset, length)
                if (bytes == null) {
                    signalingClient.send(
                        "COMMAND_ACK",
                        JSONObject().put("command", "READ_CHUNK").put("success", false).toString(),
                        msg.sender
                    )
                } else {
                    val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    val response = JSONObject()
                        .put("path", path)
                        .put("offset", offset)
                        .put("data", base64)
                    signalingClient.send("FILE_CHUNK_RESPONSE", response.toString(), msg.sender)
                }
            }
            "CREATE_EMPTY_FILE" -> {
                val success = fileManager.createEmptyFile(path)
                signalingClient.send(
                    "COMMAND_ACK",
                    JSONObject().put("command", "CREATE_EMPTY_FILE").put("success", success).toString(),
                    msg.sender
                )
                if (success) refreshFiles()
            }
            "WRITE_CHUNK" -> {
                try {
                    val base64 = root.optString("data", "")
                    val append = root.optBoolean("append", true)
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                    val success = fileManager.writeFileChunk(path, bytes, append)
                    signalingClient.send(
                        "COMMAND_ACK",
                        JSONObject().put("command", "WRITE_CHUNK").put("success", success).toString(),
                        msg.sender
                    )
                    if (success) refreshFiles()
                } catch (_: IllegalArgumentException) {
                    signalingClient.send(
                        "COMMAND_ACK",
                        JSONObject().put("command", "WRITE_CHUNK").put("success", false).toString(),
                        msg.sender
                    )
                }
            }
        }
    }

    // Role switcher
    fun setAppRole(role: AppRole) {
        _appRole.value = role
        signalingClient.setRole(role.name)
        AuditLogger.log("ROLE", "ROLE_SWITCHED", "Switched application mode to ${role.title}", AuditSeverity.INFO)
    }

    // Controller actions
    fun connectToTargetWithCode(code: String) {
        _isControllerConnecting.value = true
        _controllerErrorMessage.value = null

        val formatted = code.trim().uppercase()
        val payload = """
            {
              "type": "PAIR_BY_CODE",
              "code": "$formatted",
              "controllerName": "${identity.deviceName}",
              "controllerModel": "${android.os.Build.MODEL}",
              "fingerprint": "${identity.fingerprint}",
              "requestedScopes": ["Screen Mirroring", "Remote Interaction", "File Transfer", "App Management", "Diagnostics"]
            }
        """.trimIndent()

        val sent = signalingClient.send("PAIR_BY_CODE", payload)
        if (!sent) {
            _isControllerConnecting.value = false
            _controllerErrorMessage.value = "Signaling connection offline. Please check network."
        }
    }

    fun connectToTargetWithQr(qrJson: String) {
        try {
            val root = JSONObject(qrJson)
            val code = root.optString("pairingCode", "")
            if (code.isNotBlank()) {
                connectToTargetWithCode(code)
            } else {
                _controllerErrorMessage.value = "QR payload does not contain a valid pairing code."
            }
        } catch (e: Exception) {
            _controllerErrorMessage.value = "Invalid QR code format: ${e.message}"
        }
    }

    fun connectToTargetDeviceId(deviceId: String, name: String) {
        _isControllerConnecting.value = true
        _controllerErrorMessage.value = null

        val payload = """
            {
              "type": "PAIR_REQUEST",
              "controllerId": "${identity.deviceId}",
              "operatorName": "${identity.deviceName}",
              "operatorLocation": "Remote Android Controller",
              "fingerprint": "${identity.fingerprint}",
              "requestedScopes": ["Screen Mirroring", "Remote Interaction", "File Transfer", "App Management", "Diagnostics"]
            }
        """.trimIndent()

        signalingClient.send("PAIR_REQUEST", payload, deviceId)
    }

    fun removeRecentDevice(deviceId: String) {
        _recentTargetDevices.value = _recentTargetDevices.value.filter { it.deviceId != deviceId }
    }

    fun disconnectControllerSession() {
        val session = _activeControllerSession.value
        if (session != null) {
            remoteWebRtcSession.stop()
            signalingClient.send("EMERGENCY_DISCONNECT", """{"reason":"Controller disconnected"}""", session.targetDeviceId)
            _activeControllerSession.value = null
            AuditLogger.log("CONTROLLER", "DISCONNECTED", "Disconnected from ${session.targetDeviceName}", AuditSeverity.INFO)
        }
    }

    private fun remoteInputReady(): Boolean {
        if (remoteWebRtcSession.remoteVideo.value != null) return true
        _controllerErrorMessage.value = "Waiting for a real remote screen frame. Remote input is disabled until video is connected."
        return false
    }

    fun sendRemoteTap(x: Float, y: Float, canvasW: Float, canvasH: Float) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val targetX = (x / canvasW) * 1080f
        val targetY = (y / canvasH) * 1920f

        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "TAP",
                "x": $targetX,
                "y": $targetY
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteDoubleTap(x: Float, y: Float, canvasW: Float, canvasH: Float) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val targetX = (x / canvasW) * 1080f
        val targetY = (y / canvasH) * 1920f

        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "DOUBLE_TAP",
                "x": $targetX,
                "y": $targetY
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteLongPress(x: Float, y: Float, canvasW: Float, canvasH: Float) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val targetX = (x / canvasW) * 1080f
        val targetY = (y / canvasH) * 1920f

        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "LONG_PRESS",
                "x": $targetX,
                "y": $targetY
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteSwipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long, canvasW: Float, canvasH: Float) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val targetX1 = (x1 / canvasW) * 1080f
        val targetY1 = (y1 / canvasH) * 1920f
        val targetX2 = (x2 / canvasW) * 1080f
        val targetY2 = (y2 / canvasH) * 1920f

        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "SWIPE",
                "x": $targetX1,
                "y": $targetY1,
                "x2": $targetX2,
                "y2": $targetY2,
                "durationMs": $durationMs
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteGlobalAction(action: String) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "GLOBAL_ACTION",
                "action": "$action"
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteTextInput(text: String) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val safeText = JSONObject.quote(text)
        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "TEXT_INPUT",
                "text": $safeText
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun sendRemoteVolume(direction: String) {
        if (!remoteInputReady()) return
        val session = _activeControllerSession.value ?: return
        val payload = """
            {
              "type": "INPUT_EVENT",
              "command": {
                "type": "VOLUME",
                "action": "$direction"
              }
            }
        """.trimIndent()
        signalingClient.send("INPUT_EVENT", payload, session.targetDeviceId)
    }

    fun fetchRemoteFiles(path: String = "") {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"LIST","path":"$path"}"""
        signalingClient.send("FILE_COMMAND", payload, session.targetDeviceId)
    }

    fun deleteRemoteFile(path: String) {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"DELETE","path":"$path"}"""
        signalingClient.send("FILE_COMMAND", payload, session.targetDeviceId)
        fetchRemoteFiles()
    }

    fun fetchRemoteApps() {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"LIST"}"""
        signalingClient.send("APP_COMMAND", payload, session.targetDeviceId)
    }

    fun launchRemoteApp(packageName: String) {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"LAUNCH","packageName":"$packageName"}"""
        signalingClient.send("APP_COMMAND", payload, session.targetDeviceId)
    }

    fun openRemoteAppSettings(packageName: String) {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"SETTINGS","packageName":"$packageName"}"""
        signalingClient.send("APP_COMMAND", payload, session.targetDeviceId)
    }

    fun uninstallRemoteApp(packageName: String) {
        val session = _activeControllerSession.value ?: return
        val payload = """{"action":"UNINSTALL","packageName":"$packageName"}"""
        signalingClient.send("APP_COMMAND", payload, session.targetDeviceId)
    }

    fun runRemoteDiagnostics() {
        val session = _activeControllerSession.value ?: return
        signalingClient.send("DIAGNOSTICS_RUN", """{}""", session.targetDeviceId)
    }

    fun setRemoteViewerTab(tab: RemoteViewerTab) {
        _remoteViewerTab.value = tab
    }

    // Receiver methods
    fun selectTab(tab: MainTab) {
        _selectedTab.value = tab
    }

    fun setShowQrDialog(show: Boolean) {
        _showQrDialog.value = show
    }

    fun setShowDisconnectDialog(show: Boolean) {
        _showDisconnectDialog.value = show
    }

    fun setVideoPreset(preset: VideoPreset) {
        _videoPreset.value = preset
        remoteWebRtcSession.updatePreset(preset)
    }

    fun setScreenCaptureConsent(resultCode: Int, resultData: Intent) {
        remoteWebRtcSession.setScreenConsent(resultCode, resultData, _videoPreset.value)
    }

    fun setAppSearchQuery(query: String) {
        _appSearchQuery.value = query
    }

    fun refreshFiles() {
        _currentFileList.value = fileManager.listFiles(_currentBrowsingPath.value)
    }

    fun navigateToFolder(path: String) {
        _currentBrowsingPath.value = path
        refreshFiles()
    }

    fun deleteFile(path: String) {
        fileManager.deleteFile(path, confirmed = true)
        refreshFiles()
    }

    fun refreshApps() {
        _installedApps.value = appManager.getInstalledApps(includeSystem = false)
    }

    fun launchApp(pkg: String) {
        appManager.launchApp(pkg)
    }

    fun openAppSettings(pkg: String) {
        appManager.openAppSettings(pkg)
    }

    fun requestUninstall(pkg: String) {
        appManager.requestUninstall(pkg)
    }

    fun runDiagnostics() {
        viewModelScope.launch {
            _isDiagnosticsRunning.value = true
            diagnosticsManager.runDiagnostics()
            diagnosticsManager.refreshTelemetry()
            _isDiagnosticsRunning.value = false
        }
    }

    fun executeRepair(actionId: String) {
        viewModelScope.launch {
            diagnosticsManager.executeSafeRepair(actionId)
            runDiagnostics()
        }
    }

    fun emergencyDisconnect() {
        // Revoke the server-side peer session first, then stop any owner-visible capture service.
        signalingClient.send(
            "EMERGENCY_DISCONNECT",
            """{"reason":"Emergency Stop activated by receiver owner"}"""
        )
        pairingManager.emergencyDisconnect("Emergency Stop activated by receiver owner")
        remoteWebRtcSession.stop()
        ScreenCaptureService.stop(getApplication())
        _activeControllerSession.value?.let { session ->
            signalingClient.send(
                "EMERGENCY_DISCONNECT",
                """{"reason":"Emergency Stop activated by controller"}""",
                session.targetDeviceId
            )
        }
        _activeControllerSession.value = null
        _showDisconnectDialog.value = false
    }

    fun approveIncomingRequest(req: OperatorRequest) {
        pairingManager.approveRequest(req)
        // If request originated from an Android or Windows controller, send PAIR_ACCEPT back
        if (req.controllerId.isNotBlank()) {
            signalingClient.send(
                "PAIR_ACCEPT",
                """{"receiverName":"${identity.deviceName}","status":"APPROVED","fingerprint":"${identity.fingerprint}"}""",
                req.controllerId
            )
        }
    }

    fun rejectIncomingRequest(req: OperatorRequest) {
        pairingManager.rejectRequest(req)
        if (req.controllerId.isNotBlank()) {
            signalingClient.send(
                "PAIR_REJECT",
                """{"status":"DENIED","reason":"User declined connection request"}""",
                req.controllerId
            )
        }
    }

    fun generateNewPairingCode() {
        val code = pairingManager.generateNewPairingCode()
        signalingClient.send(
            "REGISTER_PAIRING_CODE",
            """{"code":"${code.code}","expiresAt":${code.expiresAtMillis}}"""
        )
    }

    override fun onCleared() {
        remoteWebRtcSession.close()
        signalingClient.disconnect()
        super.onCleared()
    }
}
