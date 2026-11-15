package com.example.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
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
import com.example.filetransfer.RemoteFileTransferRules
import com.example.filetransfer.TransferProgress
import com.example.pairing.OperatorRequest
import com.example.pairing.PairingManager
import com.example.remoteinput.MahiAccessibilityService
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
import com.example.webrtc.WebRtcSessionManager
import org.webrtc.SurfaceViewRenderer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

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
    val pairingManager = PairingManager(application, identity)
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
    private val remoteBrowsingHistory = mutableListOf<String>()
    private val _remoteBrowsingPath = MutableStateFlow("")
    val remoteBrowsingPath: StateFlow<String> = _remoteBrowsingPath.asStateFlow()
    private val _remoteTransferProgress = MutableStateFlow<TransferProgress?>(null)
    val remoteTransferProgress: StateFlow<TransferProgress?> = _remoteTransferProgress.asStateFlow()
    private val pendingRemoteFileResponses = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()

    private val _remoteAppList = MutableStateFlow<List<AppItem>>(emptyList())
    val remoteAppList: StateFlow<List<AppItem>> = _remoteAppList.asStateFlow()

    private val _remoteTelemetry = MutableStateFlow<RemoteTelemetry?>(null)
    val remoteTelemetry: StateFlow<RemoteTelemetry?> = _remoteTelemetry.asStateFlow()

    private val _remoteMetrics = MutableStateFlow(StreamMetrics(currentFps = 0, bitrateKbps = 0, resolution = "", framesEncoded = 0, bytesTransferred = 0, roundTripTimeMs = 0, packetLossPercent = 0f))
    val remoteMetrics: StateFlow<StreamMetrics> = _remoteMetrics.asStateFlow()

    val signalingClient: SignalingClient
    private var controllerWebRtcSession: WebRtcSessionManager? = null
    private var attachedRemoteRenderer: SurfaceViewRenderer? = null
    private val _remoteVideoHasFrames = MutableStateFlow(false)
    val remoteVideoHasFrames: StateFlow<Boolean> = _remoteVideoHasFrames.asStateFlow()

    init {
        signalingClient = SignalingClient(application, identity) { msg ->
            handleIncomingSignalingMessage(msg)
        }
        ScreenCaptureService.signalingSender = { type, payload, recipient ->
            signalingClient.send(type, payload, recipient)
        }
        signalingClient.connect()

        viewModelScope.launch {
            signalingClient.runtimeConfigJson.collect { rawConfig ->
                val browserUrl = runCatching {
                    JSONObject(rawConfig ?: "{}").optString("browserAccessUrl")
                        .takeIf { it.startsWith("https://") }
                }.getOrNull()
                pairingManager.setBrowserAccessUrl(browserUrl)
            }
        }

        refreshFiles()
        refreshApps()

        viewModelScope.launch {
            runDiagnostics()
        }
    }

    private fun messagePayloadObject(rawMessage: String): JSONObject {
        val envelope = JSONObject(rawMessage)
        return when (val payload = envelope.opt("payload")) {
            is JSONObject -> payload
            is String -> runCatching { JSONObject(payload) }.getOrDefault(envelope)
            else -> envelope
        }
    }

    private fun remoteFileResponseKey(type: String, transferId: String, offset: Long): String =
        "$type:$transferId:$offset"

    private fun completeRemoteFileResponse(msg: SignalingMessage) {
        val session = _activeControllerSession.value ?: return
        if (msg.sender != session.targetDeviceId) return
        val payload = runCatching { messagePayloadObject(msg.payload) }.getOrNull() ?: return
        val transferId = payload.optString("transferId")
        if (!RemoteFileTransferRules.isValidTransferId(transferId)) return
        val offset = if (msg.type == "FILE_OPERATION_RESULT") -1L else payload.optLong("offset", Long.MIN_VALUE)
        if (offset == Long.MIN_VALUE) return
        pendingRemoteFileResponses[remoteFileResponseKey(msg.type, transferId, offset)]?.complete(payload)
    }

    private fun failPendingRemoteFileResponses(reason: String) {
        val cancellation = CancellationException(reason)
        pendingRemoteFileResponses.values.forEach { it.completeExceptionally(cancellation) }
        pendingRemoteFileResponses.clear()
    }

    private suspend fun sendRemoteFileCommandAndAwait(
        session: ControllerSession,
        responseType: String,
        transferId: String,
        offset: Long,
        payload: JSONObject,
        commandType: String = "FILE_COMMAND"
    ): JSONObject {
        val key = remoteFileResponseKey(responseType, transferId, offset)
        val deferred = CompletableDeferred<JSONObject>()
        if (pendingRemoteFileResponses.putIfAbsent(key, deferred) != null) {
            throw IllegalStateException("A file-transfer response with this identifier is already pending.")
        }
        try {
            if (_activeControllerSession.value?.sessionId != session.sessionId) {
                throw CancellationException("The approved controller session changed.")
            }
            if (!signalingClient.send(commandType, payload.toString(), session.targetDeviceId)) {
                throw IllegalStateException("The remote file command could not be sent.")
            }
            return withTimeout(20_000L) { deferred.await() }
        } finally {
            pendingRemoteFileResponses.remove(key, deferred)
        }
    }

    private fun trackRemoteTransfer(
        transferId: String,
        fileName: String,
        totalBytes: Long,
        transferredBytes: Long,
        isUpload: Boolean,
        status: String
    ) {
        _remoteTransferProgress.value = fileManager.trackTransfer(
            id = transferId,
            fileName = fileName,
            totalBytes = totalBytes,
            transferredBytes = transferredBytes,
            isUpload = isUpload,
            status = status
        )
    }

    private fun readLocalFileMetadata(uri: Uri): Pair<String, Long> {
        val resolver = getApplication<Application>().contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "upload.bin"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        return name to size
    }

    private fun handleIncomingSignalingMessage(msg: SignalingMessage) {
        viewModelScope.launch {
            try {
                when (msg.type) {
                    "REGISTER_ACK" -> {
                        if (_appRole.value == AppRole.RECEIVER) registerCurrentPairingCode()
                    }
                    "PAIR_PENDING" -> {
                        _isControllerConnecting.value = true
                        _controllerErrorMessage.value = "Waiting for the receiver owner to approve."
                    }
                    "PAIR_REQUEST" -> {
                        val root = JSONObject(msg.payload)
                        val opName = root.optString("operatorName", root.optString("controllerName", "Mahi Remote Controller"))
                        val opLoc = root.optString("operatorLocation", "Remote Android Controller")
                        val opFp = root.optString("fingerprint", root.optString("controllerFingerprint", "UNKNOWN-FP"))
                        val cId = root.optString("controllerId", msg.sender)
                        val backendRequestId = root.optString("requestId")
                        val scopesJson = root.optJSONArray("requestedScopes")
                        val scopes = mutableListOf<String>()
                        if (scopesJson != null) {
                            for (i in 0 until scopesJson.length()) {
                                scopes.add(scopesJson.getString(i))
                            }
                        } else {
                            scopes.addAll(listOf("Screen Mirroring", "Remote Interaction", "File Transfer", "Diagnostics"))
                        }
                        pairingManager.recordIncomingOperatorRequest(
                            controllerId = cId,
                            operatorName = opName,
                            location = opLoc,
                            fingerprint = opFp,
                            scopes = scopes,
                            requestId = backendRequestId
                        )
                    }
                    "PAIR_ACCEPT" -> {
                        // Handled on Controller side: target device approved!
                        val root = JSONObject(msg.payload)
                        val sessionId = root.optString("sessionId")
                        val issuedToken = root.optString("sessionToken")
                        if (sessionId.isBlank() || issuedToken.isBlank()) {
                            _isControllerConnecting.value = false
                            _controllerErrorMessage.value = "The server did not issue a valid approved session."
                            return@launch
                        }
                        signalingClient.setSessionToken(issuedToken)
                        val receiverName = root.optString("receiverName", "Android Receiver Phone")
                        val targetFp = root.optString("fingerprint", "TARGET-FP")
                        val session = ControllerSession(
                            sessionId = sessionId,
                            targetDeviceId = msg.sender,
                            targetDeviceName = receiverName,
                            targetFingerprint = targetFp,
                            sessionToken = issuedToken,
                            connectedAtMillis = System.currentTimeMillis()
                        )
                        _activeControllerSession.value = session
                        _isControllerConnecting.value = false
                        _controllerErrorMessage.value = null
                        startControllerWebRtc(msg.sender)

                        AuditLogger.log("CONTROLLER", "SESSION_ESTABLISHED", "Approved controller session established with $receiverName", AuditSeverity.SECURITY)

                        // Request initial remote app and file catalog
                        fetchRemoteApps()
                        fetchRemoteFiles()
                    }
                    "PAIR_SESSION_AUTHORIZED" -> {
                        val root = JSONObject(msg.payload)
                        val issuedToken = root.optString("sessionToken")
                        val sessionId = root.optString("sessionId")
                        val authorizedRequestId = root.optString("requestId")
                        if (issuedToken.isNotBlank() && sessionId.isNotBlank() && authorizedRequestId.isNotBlank()) {
                            signalingClient.setSessionToken(issuedToken)
                            val activated = pairingManager.markSessionAuthorized(authorizedRequestId, sessionId)
                            if (!activated) {
                                signalingClient.send(
                                    "EMERGENCY_DISCONNECT",
                                    """{"reason":"Receiver app could not match the approved request"}"""
                                )
                                signalingClient.setSessionToken(null)
                                AuditLogger.log(
                                    "SESSION",
                                    "APPROVAL_STATE_MISMATCH",
                                    "Backend approved a request that was no longer pending locally; the session was immediately revoked.",
                                    AuditSeverity.CRITICAL
                                )
                                return@launch
                            }
                            AuditLogger.log("SESSION", "SESSION_AUTHORIZED", "Backend authorized the receiver session.", AuditSeverity.SECURITY)
                        }
                    }
                    "SDP_ANSWER" -> {
                        if (_appRole.value == AppRole.CONTROLLER) {
                            val root = JSONObject(msg.payload)
                            val activeSessionId = _activeControllerSession.value?.sessionId
                            if (activeSessionId.isNullOrBlank() || root.optString("sessionId") != activeSessionId) {
                                return@launch
                            }
                            val payload = root.optJSONObject("payload") ?: root
                            val sdp = payload.optString("sdp", root.optString("sdp"))
                            if (sdp.isNotBlank()) controllerWebRtcSession?.handleAnswer(sdp)
                        }
                    }
                    "SDP_OFFER" -> {
                        if (_appRole.value == AppRole.RECEIVER) {
                            ScreenCaptureService.handleSignalingMessage(msg.type, msg.payload)
                        }
                    }
                    "ICE_CANDIDATE" -> {
                        val root = JSONObject(msg.payload)
                        val packetSessionId = root.optString("sessionId")
                        if (_appRole.value == AppRole.CONTROLLER && controllerWebRtcSession != null) {
                            if (packetSessionId != _activeControllerSession.value?.sessionId) return@launch
                            val payload = root.optJSONObject("payload") ?: root
                            controllerWebRtcSession?.handleIceCandidate(payload)
                        } else if (_appRole.value == AppRole.RECEIVER) {
                            ScreenCaptureService.handleSignalingMessage(msg.type, msg.payload)
                        }
                    }
                    "SESSION_ENDED" -> {
                        failPendingRemoteFileResponses("The remote session ended during file transfer.")
                        signalingClient.setSessionToken(null)
                        controllerWebRtcSession?.close()
                        controllerWebRtcSession = null
                        _remoteVideoHasFrames.value = false
                        _activeControllerSession.value = null
                        pairingManager.emergencyDisconnect("Remote session ended")
                        ScreenCaptureService.stop(getApplication())
                        if (_appRole.value == AppRole.RECEIVER) generateNewPairingCode()
                    }
                    "SESSION_ERROR" -> {
                        val root = JSONObject(msg.payload)
                        _controllerErrorMessage.value = root.optString("error", "Session authorization failed.")
                    }
                    "PAIR_REJECT" -> {
                        _isControllerConnecting.value = false
                        _controllerErrorMessage.value = "Remote phone denied the connection request."
                        AuditLogger.log("CONTROLLER", "SESSION_DENIED", "Target phone rejected pairing request", AuditSeverity.WARNING)
                    }
                    "PAIR_ERROR" -> {
                        val root = JSONObject(msg.payload)
                        _isControllerConnecting.value = false
                        val reason = root.optString("error", "Pairing error occurred.")
                        if (_appRole.value == AppRole.RECEIVER) {
                            pairingManager.failApproval(reason)
                        }
                        _controllerErrorMessage.value = reason
                    }
                    "APP_LIST_RESPONSE" -> {
                        val root = JSONObject(msg.payload)
                        val raw = root.optString("payload", msg.payload)
                        val jsonArr = if (raw.startsWith("[")) JSONArray(raw) else root.optJSONArray("apps") ?: JSONArray()
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
                    "FILE_CHUNK_RESPONSE", "FILE_WRITE_ACK", "FILE_OPERATION_RESULT" -> {
                        completeRemoteFileResponse(msg)
                    }
                    "FILE_LIST_RESPONSE" -> {
                        val root = JSONObject(msg.payload)
                        val raw = root.optString("payload", msg.payload)
                        val jsonArr = if (raw.startsWith("[")) JSONArray(raw) else root.optJSONArray("files") ?: JSONArray()
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
                        val root = JSONObject(msg.payload)
                        val payloadObj = if (root.has("payload") && root.get("payload") is JSONObject) root.getJSONObject("payload") else root
                        // Never fabricate remote telemetry. Keep the last real reading
                        // until the receiver returns the requested fields.
                        if (!payloadObj.has("battery") || !payloadObj.has("temp") || !payloadObj.has("storage")) {
                            return@launch
                        }
                        val battery = payloadObj.optInt("battery", -1)
                        val temp = payloadObj.optDouble("temp", Double.NaN).toFloat()
                        val storage = payloadObj.optString("storage", "")
                        if (battery !in 0..100 || !temp.isFinite() || storage.isBlank()) {
                            return@launch
                        }
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
                    "FILE_COMMAND", "FILE_TRANSFER" -> {
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

    private fun handleInputEvent(msg: SignalingMessage) {
        val root = messagePayloadObject(msg.payload)
        val cmd = if (root.has("command")) root.getJSONObject("command") else root
        val type = cmd.optString("type", "")

        val screenW = 1080
        val screenH = 1920

        when (type.uppercase()) {
            "TAP" -> {
                val x = cmd.optDouble("x", -1.0).toFloat()
                val y = cmd.optDouble("y", -1.0).toFloat()
                MahiAccessibilityService.performTap(x, y, screenW, screenH)
            }
            "DOUBLETAP", "DOUBLE_TAP" -> {
                val x = cmd.optDouble("x", -1.0).toFloat()
                val y = cmd.optDouble("y", -1.0).toFloat()
                MahiAccessibilityService.performDoubleTap(x, y, screenW, screenH)
            }
            "LONGPRESS", "LONG_PRESS" -> {
                val x = cmd.optDouble("x", -1.0).toFloat()
                val y = cmd.optDouble("y", -1.0).toFloat()
                MahiAccessibilityService.performLongPress(x, y, screenW, screenH)
            }
            "SWIPE" -> {
                val x1 = cmd.optDouble("x", -1.0).toFloat()
                val y1 = cmd.optDouble("y", -1.0).toFloat()
                val x2 = cmd.optDouble("x2", -1.0).toFloat()
                val y2 = cmd.optDouble("y2", -1.0).toFloat()
                val duration = cmd.optLong("durationMs", 300L)
                MahiAccessibilityService.performSwipe(x1, y1, x2, y2, duration, screenW, screenH)
            }
            "DRAG" -> {
                val x1 = cmd.optDouble("x", -1.0).toFloat()
                val y1 = cmd.optDouble("y", -1.0).toFloat()
                val x2 = cmd.optDouble("x2", -1.0).toFloat()
                val y2 = cmd.optDouble("y2", -1.0).toFloat()
                val duration = cmd.optLong("durationMs", 600L)
                MahiAccessibilityService.performDrag(x1, y1, x2, y2, duration, screenW, screenH)
            }
            "SCROLL" -> {
                val action = cmd.optString("action", "DOWN")
                val startY = if (action.equals("UP", ignoreCase = true)) 1400f else 600f
                val endY = if (action.equals("UP", ignoreCase = true)) 600f else 1400f
                MahiAccessibilityService.performSwipe(540f, startY, 540f, endY, 250L, screenW, screenH)
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
        val root = messagePayloadObject(msg.payload)
        val action = root.optString("action", "LIST")
        val pkg = root.optString("packageName", "")

        when (action.uppercase()) {
            "LIST" -> {
                val apps = appManager.getInstalledApps(false)
                val result = JSONArray()
                apps.take(50).forEach { app ->
                    result.put(
                        JSONObject()
                            .put("name", app.appName)
                            .put("pkg", app.packageName)
                            .put("ver", app.versionName)
                    )
                }
                signalingClient.send("APP_LIST_RESPONSE", result.toString(), msg.sender)
            }
            "LAUNCH" -> if (pkg.isNotBlank()) appManager.launchApp(pkg)
            "SETTINGS" -> if (pkg.isNotBlank()) appManager.openAppSettings(pkg)
            "UNINSTALL" -> if (pkg.isNotBlank()) appManager.requestUninstall(pkg)
        }
    }

    private fun handleFileCommand(msg: SignalingMessage) {
        val root = messagePayloadObject(msg.payload)
        val action = root.optString("action", "LIST").uppercase()
        val path = root.optString("path", "")

        when (action) {
            "LIST" -> {
                val files = if (path.isBlank()) fileManager.listPermittedRootFolders() else fileManager.listFiles(path)
                val result = JSONArray()
                files.forEach { file ->
                    result.put(
                        JSONObject()
                            .put("name", file.name)
                            .put("path", file.path)
                            .put("isDir", file.isDirectory)
                            .put("size", file.sizeBytes)
                    )
                }
                signalingClient.send("FILE_LIST_RESPONSE", result.toString(), msg.sender)
            }
            "DELETE" -> {
                val success = fileManager.deleteFile(path, confirmed = true)
                signalingClient.send(
                    "FILE_OPERATION_RESULT",
                    JSONObject().put("action", "DELETE").put("path", path).put("success", success).toString(),
                    msg.sender
                )
                refreshFiles()
            }
            "CREATE_FOLDER" -> {
                val name = root.optString("name", "NewFolder")
                val success = fileManager.createFolder(path, name)
                signalingClient.send(
                    "FILE_OPERATION_RESULT",
                    JSONObject().put("action", "CREATE_FOLDER").put("path", path).put("success", success).toString(),
                    msg.sender
                )
                refreshFiles()
            }
            "READ_CHUNK" -> {
                val transferId = root.optString("transferId")
                val offset = root.optLong("offset", -1L)
                val length = root.optInt("length", RemoteFileTransferRules.CHUNK_BYTES)
                val valid = RemoteFileTransferRules.isValidTransferId(transferId) &&
                    offset >= 0L && length in 1..RemoteFileTransferRules.CHUNK_BYTES
                val bytes = if (valid) fileManager.readFileChunk(path, offset, length) else null
                val response = JSONObject()
                    .put("path", path)
                    .put("transferId", transferId)
                    .put("offset", offset)
                    .put("ok", bytes != null && bytes.size == length)
                    .put("data", if (bytes != null) android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) else "")
                    .put("fileSize", File(path).takeIf { it.isFile }?.length() ?: -1L)
                if (!valid) response.put("error", "Invalid file chunk request.")
                signalingClient.send("FILE_CHUNK_RESPONSE", response.toString(), msg.sender)
            }
            "WRITE_CHUNK" -> {
                val transferId = root.optString("transferId")
                val offset = root.optLong("offset", -1L)
                val append = root.optBoolean("append", offset > 0L)
                try {
                    val bytes = android.util.Base64.decode(root.optString("data", ""), android.util.Base64.DEFAULT)
                    val file = File(path)
                    val existingLength = if (file.isFile) file.length() else 0L
                    val valid = RemoteFileTransferRules.isValidTransferId(transferId) &&
                        offset >= 0L && offset == existingLength && append == (offset > 0L) &&
                        bytes.size <= RemoteFileTransferRules.CHUNK_BYTES &&
                        path.endsWith(".mahi-upload-$transferId.part") &&
                        (append || !file.exists())
                    val success = valid && fileManager.writeFileChunk(path, bytes, append)
                    signalingClient.send(
                        "FILE_WRITE_ACK",
                        JSONObject()
                            .put("path", path)
                            .put("transferId", transferId)
                            .put("offset", offset)
                            .put("success", success)
                            .put("bytesWritten", if (success) bytes.size else 0)
                            .put("error", if (valid) "" else "Invalid or out-of-sequence upload chunk")
                            .toString(),
                        msg.sender
                    )
                } catch (error: Exception) {
                    signalingClient.send(
                        "FILE_WRITE_ACK",
                        JSONObject()
                            .put("path", path)
                            .put("transferId", transferId)
                            .put("offset", offset)
                            .put("success", false)
                            .put("bytesWritten", 0)
                            .put("error", error.message ?: "Invalid upload chunk")
                            .toString(),
                        msg.sender
                    )
                }
            }
            "FINALIZE_UPLOAD" -> {
                val transferId = root.optString("transferId")
                val temporaryPath = root.optString("temporaryPath")
                val destinationPath = root.optString("destinationPath")
                val destination = File(destinationPath)
                val expectedTemporaryPath = "$destinationPath.mahi-upload-$transferId.part"
                val success = RemoteFileTransferRules.isValidTransferId(transferId) &&
                    destinationPath.isNotBlank() && temporaryPath == expectedTemporaryPath &&
                    !destination.exists() && fileManager.moveFileToPath(temporaryPath, destinationPath)
                signalingClient.send(
                    "FILE_OPERATION_RESULT",
                    JSONObject()
                        .put("action", "FINALIZE_UPLOAD")
                        .put("transferId", transferId)
                        .put("success", success)
                        .put("path", destinationPath)
                        .toString(),
                    msg.sender
                )
                if (success) refreshFiles()
            }
            "ABORT_UPLOAD" -> {
                val transferId = root.optString("transferId")
                val temporaryPath = root.optString("temporaryPath")
                if (RemoteFileTransferRules.isValidTransferId(transferId) &&
                    temporaryPath.endsWith(".mahi-upload-$transferId.part")) {
                    fileManager.deleteFile(temporaryPath, confirmed = true)
                    refreshFiles()
                }
            }
        }
    }

    // Role switcher    // Role switcher
    fun setAppRole(role: AppRole) {
        _appRole.value = role
        signalingClient.setRole(role.name)
        AuditLogger.log("ROLE", "ROLE_SWITCHED", "Switched application mode to ${role.title}", AuditSeverity.INFO)
    }

    // Controller actions
    fun connectToTargetWithCode(code: String) {
        _isControllerConnecting.value = true
        _controllerErrorMessage.value = null

        val formattedCode = code.filter(Char::isDigit)
        if (formattedCode.length != 6) {
            _isControllerConnecting.value = false
            _controllerErrorMessage.value = "Enter the six-digit pairing code."
            return
        }

        val payload = JSONObject()
            .put("code", formattedCode)
            .put("operatorName", identity.deviceName)
            .put(
                "requestedScopes",
                JSONArray(listOf("Screen Mirroring", "Remote Interaction", "File Transfer", "Diagnostics"))
            )
            .toString()

        val sent = signalingClient.send("PAIR_BY_CODE", payload)
        if (!sent) {
            _isControllerConnecting.value = false
            _controllerErrorMessage.value = "Signaling connection offline. Please check network."
        }
    }

    fun connectToTargetWithQr(qrJson: String) {
        try {
            val trimmed = qrJson.trim()
            val code = if (trimmed.startsWith("{")) {
                JSONObject(trimmed).optString("pairingCode", "")
            } else {
                android.net.Uri.parse(trimmed).getQueryParameter("code").orEmpty()
            }
            if (code.filter(Char::isDigit).length == 6) {
                connectToTargetWithCode(code)
            } else {
                _controllerErrorMessage.value = "QR code does not contain a valid six-digit pairing code."
            }
        } catch (e: Exception) {
            _controllerErrorMessage.value = "Invalid QR code format: ${e.message}"
        }
    }

    fun connectToTargetDeviceId(deviceId: String, name: String) {
        _isControllerConnecting.value = false
        _controllerErrorMessage.value =
            "Direct device-ID pairing is disabled. Ask the receiver to share a temporary six-digit code or QR, then connect with that code."
        AuditLogger.log(
            "PAIRING",
            "DIRECT_ID_PAIRING_DISABLED",
            "Rejected direct device-ID pairing for $deviceId. A fresh pairing code and owner approval are required.",
            AuditSeverity.WARNING
        )
    }

    fun removeRecentDevice(deviceId: String) {
        _recentTargetDevices.value = _recentTargetDevices.value.filter { it.deviceId != deviceId }
    }

    fun disconnectControllerSession() {
        failPendingRemoteFileResponses("The controller disconnected during file transfer.")
        val session = _activeControllerSession.value
        if (session != null) {
            signalingClient.send("EMERGENCY_DISCONNECT", """{"reason":"Controller disconnected"}""", session.targetDeviceId)
            signalingClient.setSessionToken(null)
            _activeControllerSession.value = null
            AuditLogger.log("CONTROLLER", "DISCONNECTED", "Disconnected from ${session.targetDeviceName}", AuditSeverity.INFO)
        }
    }

    fun sendRemoteTap(x: Float, y: Float, canvasW: Float, canvasH: Float) {
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

    fun fetchRemoteFiles(path: String = _remoteBrowsingPath.value) {
        val session = _activeControllerSession.value ?: return
        val payload = JSONObject().put("action", "LIST").put("path", path).toString()
        signalingClient.send("FILE_COMMAND", payload, session.targetDeviceId)
    }

    fun navigateRemoteFolder(path: String) {
        if (path.isBlank() || path == _remoteBrowsingPath.value) return
        remoteBrowsingHistory.add(_remoteBrowsingPath.value)
        _remoteBrowsingPath.value = path
        fetchRemoteFiles(path)
    }

    fun navigateRemoteParent() {
        if (remoteBrowsingHistory.isEmpty()) return
        _remoteBrowsingPath.value = remoteBrowsingHistory.removeAt(remoteBrowsingHistory.lastIndex)
        fetchRemoteFiles(_remoteBrowsingPath.value)
    }

    private fun resetRemoteNavigation() {
        remoteBrowsingHistory.clear()
        _remoteBrowsingPath.value = ""
    }

    fun deleteRemoteFile(path: String) {
        val session = _activeControllerSession.value ?: return
        val payload = JSONObject().put("action", "DELETE").put("path", path).toString()
        signalingClient.send("FILE_COMMAND", payload, session.targetDeviceId)
        fetchRemoteFiles()
    }

    fun uploadRemoteFile(uri: Uri) {
        val session = _activeControllerSession.value ?: return
        val remoteDirectory = _remoteBrowsingPath.value
        if (remoteDirectory.isBlank()) {
            _controllerErrorMessage.value = "Open a permitted receiver folder before uploading."
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            val transferId = UUID.randomUUID().toString()
            var temporaryPath = ""
            var fileName = "upload.bin"
            var totalBytes = 0L
            var transferredBytes = 0L
            try {
                val metadata = readLocalFileMetadata(uri)
                fileName = RemoteFileTransferRules.safeFileName(metadata.first)
                    ?: throw IllegalArgumentException("The selected file name is invalid.")
                if (metadata.second > RemoteFileTransferRules.MAX_FILE_BYTES) {
                    throw IllegalArgumentException("Files larger than 1 GiB are not supported.")
                }
                val declaredSize = metadata.second
                totalBytes = declaredSize.coerceAtLeast(0L)
                val destinationPath = File(remoteDirectory, fileName).absolutePath
                temporaryPath = RemoteFileTransferRules.temporaryUploadPath(destinationPath, transferId)
                val input = getApplication<Application>().contentResolver.openInputStream(uri)
                    ?: throw IllegalStateException("The selected local file could not be opened.")

                input.use { stream ->
                    val buffer = ByteArray(RemoteFileTransferRules.CHUNK_BYTES)
                    var firstChunk = true
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) {
                            if (firstChunk) {
                                val ack = sendRemoteFileCommandAndAwait(
                                    session, "FILE_WRITE_ACK", transferId, 0L,
                                    JSONObject()
                                        .put("action", "WRITE_CHUNK")
                                        .put("path", temporaryPath)
                                        .put("transferId", transferId)
                                        .put("offset", 0L)
                                        .put("append", false)
                                        .put("data", "")
                                )
                                if (!ack.optBoolean("success") || ack.optInt("bytesWritten", -1) != 0) {
                                    throw IllegalStateException(ack.optString("error", "Receiver rejected the empty-file chunk."))
                                }
                            }
                            break
                        }
                        if (count == 0) continue
                        val nextOffset = transferredBytes + count
                        if (nextOffset > RemoteFileTransferRules.MAX_FILE_BYTES ||
                            (declaredSize >= 0L && nextOffset > declaredSize)) {
                            throw IllegalStateException("The local file changed or exceeded the 1 GiB transfer limit.")
                        }
                        val chunkOffset = transferredBytes
                        val encoded = android.util.Base64.encodeToString(buffer.copyOf(count), android.util.Base64.NO_WRAP)
                        val ack = sendRemoteFileCommandAndAwait(
                            session, "FILE_WRITE_ACK", transferId, chunkOffset,
                            JSONObject()
                                .put("action", "WRITE_CHUNK")
                                .put("path", temporaryPath)
                                .put("transferId", transferId)
                                .put("offset", chunkOffset)
                                .put("append", chunkOffset > 0L)
                                .put("data", encoded)
                        )
                        if (!ack.optBoolean("success") ||
                            ack.optInt("bytesWritten", -1) != count ||
                            ack.optLong("offset", -1L) != chunkOffset) {
                            throw IllegalStateException(ack.optString("error", "Receiver did not acknowledge the complete upload chunk."))
                        }
                        transferredBytes = nextOffset
                        firstChunk = false
                        trackRemoteTransfer(transferId, fileName, totalBytes, transferredBytes, true, "IN_PROGRESS")
                    }
                }

                if (declaredSize >= 0L && transferredBytes != declaredSize) {
                    throw IllegalStateException("The local file size changed during upload.")
                }
                val finalized = sendRemoteFileCommandAndAwait(
                    session, "FILE_OPERATION_RESULT", transferId, -1L,
                    JSONObject()
                        .put("action", "FINALIZE_UPLOAD")
                        .put("transferId", transferId)
                        .put("temporaryPath", temporaryPath)
                        .put("destinationPath", destinationPath),
                    commandType = "FILE_TRANSFER"
                )
                if (!finalized.optBoolean("success")) {
                    throw IllegalStateException("Receiver could not finalize the upload. A file with that name may already exist.")
                }
                trackRemoteTransfer(transferId, fileName, totalBytes, transferredBytes, true, "COMPLETED")
                fetchRemoteFiles(remoteDirectory)
            } catch (error: Exception) {
                if (temporaryPath.isNotBlank()) {
                    signalingClient.send(
                        "FILE_TRANSFER",
                        JSONObject()
                            .put("action", "ABORT_UPLOAD")
                            .put("transferId", transferId)
                            .put("temporaryPath", temporaryPath)
                            .toString(),
                        session.targetDeviceId
                    )
                }
                trackRemoteTransfer(transferId, fileName, totalBytes, transferredBytes, true, "FAILED")
                _controllerErrorMessage.value = "Upload failed: ${error.message ?: "unknown transfer error"}"
                AuditLogger.log("FILE", "REMOTE_UPLOAD_FAILED", "Remote upload failed for $fileName: ${error.message}", AuditSeverity.WARNING)
            }
        }
    }

    fun downloadRemoteFile(remoteFile: FileEntry, destinationUri: Uri) {
        val session = _activeControllerSession.value ?: return
        if (remoteFile.isDirectory) {
            _controllerErrorMessage.value = "Select a file, not a folder, to download."
            return
        }
        if (remoteFile.sizeBytes !in 0..RemoteFileTransferRules.MAX_FILE_BYTES) {
            _controllerErrorMessage.value = "The remote file size is invalid or exceeds 1 GiB."
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            val transferId = UUID.randomUUID().toString()
            var transferredBytes = 0L
            try {
                val output = getApplication<Application>().contentResolver.openOutputStream(destinationUri, "wt")
                    ?: throw IllegalStateException("The selected download destination could not be opened.")
                output.use { stream ->
                    while (transferredBytes < remoteFile.sizeBytes) {
                        val length = RemoteFileTransferRules.chunkLength(remoteFile.sizeBytes, transferredBytes)
                        val response = sendRemoteFileCommandAndAwait(
                            session, "FILE_CHUNK_RESPONSE", transferId, transferredBytes,
                            JSONObject()
                                .put("action", "READ_CHUNK")
                                .put("path", remoteFile.path)
                                .put("transferId", transferId)
                                .put("offset", transferredBytes)
                                .put("length", length)
                        )
                        if (!response.optBoolean("ok")) {
                            throw IllegalStateException(response.optString("error", "Receiver could not read the requested file chunk."))
                        }
                        val chunk = try {
                            android.util.Base64.decode(response.optString("data", ""), android.util.Base64.DEFAULT)
                        } catch (_: Exception) {
                            throw IllegalStateException("Receiver returned invalid chunk encoding.")
                        }
                        val reportedSize = response.optLong("fileSize", remoteFile.sizeBytes)
                        if (chunk.size != length ||
                            response.optLong("offset", -1L) != transferredBytes ||
                            (reportedSize >= 0L && reportedSize != remoteFile.sizeBytes)) {
                            throw IllegalStateException("The remote file changed or a chunk was incomplete.")
                        }
                        stream.write(chunk)
                        transferredBytes += chunk.size
                        trackRemoteTransfer(
                            transferId, remoteFile.name, remoteFile.sizeBytes,
                            transferredBytes, false, "IN_PROGRESS"
                        )
                    }
                }
                trackRemoteTransfer(
                    transferId, remoteFile.name, remoteFile.sizeBytes,
                    transferredBytes, false, "COMPLETED"
                )
            } catch (error: Exception) {
                runCatching {
                    DocumentsContract.deleteDocument(
                        getApplication<Application>().contentResolver,
                        destinationUri
                    )
                }
                trackRemoteTransfer(
                    transferId, remoteFile.name, remoteFile.sizeBytes,
                    transferredBytes, false, "FAILED"
                )
                _controllerErrorMessage.value = "Download failed: ${error.message ?: "unknown transfer error"}"
                AuditLogger.log("FILE", "REMOTE_DOWNLOAD_FAILED", "Remote download failed for ${remoteFile.name}: ${error.message}", AuditSeverity.WARNING)
            }
        }
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
        if (signalingClient.connectionStatus.value == ConnectionStatus.AUTHENTICATED) {
            signalingClient.send("EMERGENCY_DISCONNECT", """{"reason":"Receiver owner activated Emergency Stop"}""")
        }
        signalingClient.setSessionToken(null)
        pairingManager.emergencyDisconnect("Emergency killswitch activated by user")
        ScreenCaptureService.stop(getApplication())
        if (_appRole.value == AppRole.RECEIVER) generateNewPairingCode()
        _showDisconnectDialog.value = false
    }

    fun approveIncomingRequest(req: OperatorRequest) {
        if (req.controllerId.isBlank()) return
        pairingManager.approveRequest(req)
        val sent = signalingClient.send(
            "PAIR_ACCEPT",
            JSONObject()
                .put("requestId", req.requestId)
                .put("status", "APPROVED")
                .toString()
        )
        if (!sent) {
            pairingManager.failApproval("The approval could not be sent to the signaling server.")
            _controllerErrorMessage.value = "Approval could not be sent. Check the connection and try pairing again."
        }
    }

    fun rejectIncomingRequest(req: OperatorRequest) {
        pairingManager.rejectRequest(req)
        if (req.controllerId.isNotBlank()) {
            signalingClient.send(
                "PAIR_REJECT",
                JSONObject()
                    .put("requestId", req.requestId)
                    .put("status", "DENIED")
                    .put("reason", "User declined connection request")
                    .toString()
            )
        }
    }

    private fun startControllerWebRtc(receiverDeviceId: String) {
        controllerWebRtcSession?.close()
        controllerWebRtcSession = null
        _remoteVideoHasFrames.value = false

        signalingClient.fetchSessionIceConfig(
            onSuccess = { iceConfig ->
                if (_activeControllerSession.value?.targetDeviceId != receiverDeviceId) return@fetchSessionIceConfig
                val manager = WebRtcSessionManager(
                    context = getApplication(),
                    sendSignal = { type, payload, recipient ->
                        signalingClient.send(type, payload, recipient)
                    },
                    onFirstRemoteFrame = {
                        _remoteVideoHasFrames.value = true
                    },
                    onError = { message ->
                        _controllerErrorMessage.value = message
                    }
                )
                controllerWebRtcSession = manager
                attachedRemoteRenderer?.let(manager::initializeRenderer)
                try {
                    manager.startController(iceConfig, receiverDeviceId)
                } catch (error: Exception) {
                    manager.close()
                    if (controllerWebRtcSession === manager) controllerWebRtcSession = null
                    _controllerErrorMessage.value =
                        error.message ?: "Could not start the remote video connection."
                }
            },
            onFailure = { error ->
                _controllerErrorMessage.value = error
            }
        )
    }

    fun attachRemoteVideoRenderer(renderer: SurfaceViewRenderer) {
        attachedRemoteRenderer = renderer
        controllerWebRtcSession?.initializeRenderer(renderer)
    }

    fun detachRemoteVideoRenderer(renderer: SurfaceViewRenderer) {
        controllerWebRtcSession?.releaseRenderer(renderer)
        if (attachedRemoteRenderer === renderer) attachedRemoteRenderer = null
    }

    fun startReceiverScreenShare(resultCode: Int, resultData: Intent) {
        val session = pairingManager.activeSession.value
        if (session == null || session.controllerId.isBlank() ||
            signalingClient.connectionStatus.value != ConnectionStatus.AUTHENTICATED) {
            AuditLogger.log(
                "SCREEN",
                "SHARE_NOT_AUTHORIZED",
                "Screen sharing was not started because there is no approved, authenticated controller session.",
                AuditSeverity.WARNING
            )
            return
        }

        signalingClient.fetchSessionIceConfig(
            onSuccess = { iceConfig ->
                val serviceIntent = Intent(getApplication(), ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                    putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, resultData)
                    putExtra(ScreenCaptureService.EXTRA_PRESET, _videoPreset.value.name)
                    putExtra(ScreenCaptureService.EXTRA_ICE_CONFIG, iceConfig)
                    putExtra(ScreenCaptureService.EXTRA_TARGET_DEVICE_ID, session.controllerId)
                    putExtra(ScreenCaptureService.EXTRA_SESSION_ID, session.sessionId)
                }
                androidx.core.content.ContextCompat.startForegroundService(getApplication(), serviceIntent)
            },
            onFailure = { error ->
                AuditLogger.log("SCREEN", "ICE_CONFIG_FAILED", error, AuditSeverity.WARNING)
            }
        )
    }

    private fun registerCurrentPairingCode() {
        pairingManager.currentPairingCode.value?.let { code ->
            signalingClient.send(
                "REGISTER_PAIRING_CODE",
                JSONObject()
                    .put("code", code.code.filter(Char::isDigit))
                    .put("expiresAtMs", code.expiresAtMillis)
                    .toString()
            )
        }
    }

    fun generateNewPairingCode() {
        pairingManager.generateNewPairingCode()
        registerCurrentPairingCode()
    }

    override fun onCleared() {
        failPendingRemoteFileResponses("The controller screen was closed.")
        signalingClient.disconnect()
        super.onCleared()
    }
}
