package com.example.pairing

import android.content.Context
import android.net.Uri
import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.security.DeviceIdentity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID

class PairingManager(private val context: Context) {

    private val secureRandom = SecureRandom()
    private val identity = DeviceIdentity.getOrCreateIdentity(context)
    @Volatile private var browserAccessUrl: String? = null

    private val _currentPairingCode = MutableStateFlow<PairingCodeData?>(null)
    val currentPairingCode: StateFlow<PairingCodeData?> = _currentPairingCode.asStateFlow()

    private val _activeSession = MutableStateFlow<ActiveSession?>(null)
    val activeSession: StateFlow<ActiveSession?> = _activeSession.asStateFlow()

    private val _pendingRequest = MutableStateFlow<OperatorRequest?>(null)
    val pendingRequest: StateFlow<OperatorRequest?> = _pendingRequest.asStateFlow()

    private val _approvalInProgress = MutableStateFlow(false)
    val approvalInProgress: StateFlow<Boolean> = _approvalInProgress.asStateFlow()
    private var approvalRequest: OperatorRequest? = null

    private val _trustedControllers = MutableStateFlow<List<TrustedController>>(emptyList())
    val trustedControllers: StateFlow<List<TrustedController>> = _trustedControllers.asStateFlow()

    init {
        // Generate initial pairing code
        generateNewPairingCode()
    }

    fun generateNewPairingCode(): PairingCodeData {
        val num = secureRandom.nextInt(900000) + 100000
        val formattedCode = "%03d-%03d".format(num / 1000, num % 1000)
        val expiresAt = System.currentTimeMillis() + (5 * 60 * 1000L) // 5 minutes

        val qrPayload = buildQrPayload(formattedCode, expiresAt)

        val data = PairingCodeData(
            code = formattedCode,
            expiresAtMillis = expiresAt,
            qrPayloadJson = qrPayload
        )
        _currentPairingCode.value = data
        AuditLogger.log("PAIRING", "CODE_GENERATED", "Generated 6-digit code: $formattedCode (expires in 5m)", AuditSeverity.INFO)
        return data
    }

    fun setBrowserAccessUrl(url: String?) {
        val validated = url?.takeIf {
            runCatching {
                val parsed = Uri.parse(it)
                parsed.scheme == "https" && !parsed.host.isNullOrBlank()
            }.getOrDefault(false)
        }?.trimEnd('/')
        if (browserAccessUrl == validated) return
        browserAccessUrl = validated
        _currentPairingCode.value?.let { current ->
            _currentPairingCode.value = current.copy(
                qrPayloadJson = buildQrPayload(current.code, current.expiresAtMillis)
            )
        }
    }

    private fun buildQrPayload(code: String, expiresAt: Long): String {
        val baseUrl = browserAccessUrl
        if (!baseUrl.isNullOrBlank()) {
            return Uri.parse(baseUrl)
                .buildUpon()
                .appendQueryParameter("code", code.filter(Char::isDigit))
                .appendQueryParameter("expiresAt", expiresAt.toString())
                .build()
                .toString()
        }

        return JSONObject()
            .put("deviceId", identity.deviceId)
            .put("deviceName", identity.deviceName)
            .put("fingerprint", identity.fingerprint)
            .put("pairingCode", code)
            .put("expiresAt", expiresAt)
            .put("v", 1)
            .toString()
    }

    fun recordIncomingOperatorRequest(
        controllerId: String,
        operatorName: String,
        location: String,
        fingerprint: String,
        scopes: List<String>,
        requestId: String? = null
    ) {
        val request = OperatorRequest(
            requestId = requestId?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString(),
            controllerId = controllerId,
            operatorName = operatorName,
            operatorLocation = location,
            controllerFingerprint = fingerprint,
            requestedScopes = scopes,
            timestamp = System.currentTimeMillis()
        )
        _pendingRequest.value = request
        AuditLogger.log("PAIRING", "OPERATOR_REQUEST", "Connection request from $operatorName ($location)", AuditSeverity.SECURITY)
    }

    fun approveRequest(request: OperatorRequest) {
        if (_pendingRequest.value?.requestId != request.requestId || _approvalInProgress.value) return
        approvalRequest = request
        _approvalInProgress.value = true
        AuditLogger.log(
            "PAIRING",
            "APPROVAL_SENT",
            "Owner approval was sent to the backend; waiting for a signed session authorization.",
            AuditSeverity.SECURITY
        )
    }

    fun markSessionAuthorized(sessionId: String): Boolean {
        val request = approvalRequest ?: return false
        if (sessionId.isBlank()) return false

        val session = ActiveSession(
            sessionId = sessionId,
            operatorName = request.operatorName,
            operatorLocation = request.operatorLocation,
            controllerFingerprint = request.controllerFingerprint,
            startedAtMillis = System.currentTimeMillis(),
            controllerId = request.controllerId,
            isScreenStreaming = false,
            isInputEnabled = true
        )
        _activeSession.value = session
        _pendingRequest.value = null
        approvalRequest = null
        _approvalInProgress.value = false

        val existing = _trustedControllers.value.find { it.fingerprint == request.controllerFingerprint }
        val updatedList = if (existing != null) {
            _trustedControllers.value.map {
                if (it.fingerprint == request.controllerFingerprint) {
                    it.copy(lastConnectedAtMillis = System.currentTimeMillis(), isRevoked = false)
                } else it
            }
        } else {
            _trustedControllers.value + TrustedController(
                id = "ctrl_" + UUID.randomUUID().toString().take(8),
                name = request.operatorName,
                location = request.operatorLocation,
                fingerprint = request.controllerFingerprint,
                pairedAtMillis = System.currentTimeMillis(),
                lastConnectedAtMillis = System.currentTimeMillis()
            )
        }
        _trustedControllers.value = updatedList

        AuditLogger.log(
            "SESSION",
            "ESTABLISHED",
            "Backend authorized session ${session.sessionId.take(8)} for ${request.operatorName}.",
            AuditSeverity.SECURITY
        )
        return true
    }

    fun failApproval(reason: String) {
        if (approvalRequest == null && !_approvalInProgress.value) return
        approvalRequest = null
        _approvalInProgress.value = false
        _pendingRequest.value = null
        AuditLogger.log("PAIRING", "APPROVAL_FAILED", reason, AuditSeverity.WARNING)
    }

    fun rejectRequest(request: OperatorRequest) {
        approvalRequest = null
        _approvalInProgress.value = false
        _pendingRequest.value = null
        AuditLogger.log("PAIRING", "REJECTED_BY_USER", "Denied connection from ${request.operatorName}", AuditSeverity.WARNING)
    }

    fun revokeController(controllerId: String) {
        val target = _trustedControllers.value.find { it.id == controllerId }
        _trustedControllers.value = _trustedControllers.value.map {
            if (it.id == controllerId) it.copy(isRevoked = true) else it
        }
        if (target != null && _activeSession.value?.controllerFingerprint == target.fingerprint) {
            emergencyDisconnect("Trusted controller was revoked by device owner")
        }
        AuditLogger.log("SECURITY", "CONTROLLER_REVOKED", "Revoked credentials for $controllerId", AuditSeverity.CRITICAL)
    }

    fun emergencyDisconnect(reason: String = "Emergency disconnect triggered by user") {
        val currentSession = _activeSession.value
        _activeSession.value = null
        _pendingRequest.value = null
        approvalRequest = null
        _approvalInProgress.value = false
        AuditLogger.log(
            category = "SECURITY",
            action = "EMERGENCY_DISCONNECT",
            details = "$reason (Terminated session ${currentSession?.sessionId?.take(8) ?: "N/A"})",
            severity = AuditSeverity.CRITICAL
        )
    }
}
