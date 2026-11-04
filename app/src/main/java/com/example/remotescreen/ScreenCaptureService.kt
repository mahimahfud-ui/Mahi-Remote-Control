package com.example.remotescreen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.example.MainActivity
import com.example.R
import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import com.example.webrtc.WebRtcSessionManager
import org.json.JSONObject
import org.webrtc.PeerConnection
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.flow.asStateFlow

class ScreenCaptureService : Service() {

    private var webRtcSession: WebRtcSessionManager? = null
    @Volatile private var activeSessionId: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    companion object {
        const val ACTION_START = "com.example.action.START_STREAM"
        const val ACTION_STOP = "com.example.action.STOP_STREAM"
        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_PRESET = "extra_preset"
        const val EXTRA_ICE_CONFIG = "extra_ice_config"
        const val EXTRA_TARGET_DEVICE_ID = "extra_target_device_id"
        const val EXTRA_SESSION_ID = "extra_session_id"

        private const val NOTIFICATION_ID = 9021
        private const val CHANNEL_ID = "mahi_remote_screen_channel"

        private val _streamState = kotlinx.coroutines.flow.MutableStateFlow<ScreenStreamState>(
            ScreenStreamState.Idle
        )
        val streamState: kotlinx.coroutines.flow.StateFlow<ScreenStreamState> =
            _streamState.asStateFlow()

        @Volatile
        var signalingSender: ((String, String, String?) -> Boolean)? = null

        @Volatile
        private var runningInstance: ScreenCaptureService? = null

        private val pendingSignals = ConcurrentLinkedQueue<Pair<String, String>>()

        fun isStreaming(): Boolean = _streamState.value is ScreenStreamState.Active

        fun stop(context: Context) {
            val intent = Intent(context, ScreenCaptureService::class.java).apply {
                action = ACTION_STOP
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun handleSignalingMessage(type: String, rawMessage: String) {
            val service = runningInstance
            if (service == null) {
                pendingSignals.add(type to rawMessage)
                return
            }
            service.dispatchSignal(type, rawMessage)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        runningInstance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                val presetName = intent.getStringExtra(EXTRA_PRESET) ?: VideoPreset.BALANCED.name
                val preset = runCatching { VideoPreset.valueOf(presetName) }
                    .getOrDefault(VideoPreset.BALANCED)
                val iceConfig = intent.getStringExtra(EXTRA_ICE_CONFIG).orEmpty()
                val targetDeviceId = intent.getStringExtra(EXTRA_TARGET_DEVICE_ID).orEmpty()
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()

                if (resultData == null || iceConfig.isBlank() || targetDeviceId.isBlank() || sessionId.isBlank()) {
                    _streamState.value = ScreenStreamState.Error(
                        "Screen sharing needs Android consent, ICE configuration and an approved controller session."
                    )
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                startCapture(resultCode, resultData, preset, iceConfig, targetDeviceId, sessionId)
            }
            ACTION_STOP -> {
                stopCapture()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture(
        resultCode: Int,
        resultData: Intent,
        preset: VideoPreset,
        iceConfig: String,
        controllerDeviceId: String,
        sessionId: String
    ) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildForegroundNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                )
            } else {
                startForeground(NOTIFICATION_ID, buildForegroundNotification())
            }

            stopCurrentWebRtcSession()
            activeSessionId = sessionId
            _streamState.value = ScreenStreamState.RequestingConsent

            val manager = WebRtcSessionManager(
                context = this,
                sendSignal = { type, payload, recipient ->
                    signalingSender?.invoke(type, payload, recipient) ?: false
                },
                onConnectionState = { state ->
                    when (state) {
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            _streamState.value = ScreenStreamState.Active(
                                metrics = StreamMetrics(
                                    currentFps = 0,
                                    bitrateKbps = 0,
                                    resolution = preset.width.toString() + "x" + preset.height
                                ),
                                preset = preset
                            )
                            AuditLogger.log(
                                "SCREEN",
                                "MEDIA_CONNECTED",
                                "WebRTC media transport connected to the approved controller.",
                                AuditSeverity.SECURITY
                            )
                        }
                        PeerConnection.PeerConnectionState.FAILED -> {
                            mainHandler.post {
                                _streamState.value = ScreenStreamState.Error(
                                    "WebRTC connection failed. Check internet and TURN connectivity."
                                )
                                stopCapture()
                                stopForeground(STOP_FOREGROUND_REMOVE)
                                stopSelf()
                            }
                        }
                        PeerConnection.PeerConnectionState.DISCONNECTED,
                        PeerConnection.PeerConnectionState.CLOSED -> {
                            if (_streamState.value !is ScreenStreamState.Error) {
                                _streamState.value = ScreenStreamState.Stopped
                            }
                        }
                        else -> Unit
                    }
                },
                onError = { message ->
                    mainHandler.post {
                        _streamState.value = ScreenStreamState.Error(message)
                        AuditLogger.log("SCREEN", "MEDIA_ERROR", message, AuditSeverity.WARNING)
                        stopCapture()
                        stopForeground(STOP_FOREGROUND_REMOVE)
                        stopSelf()
                    }
                }
            )
            webRtcSession = manager
            manager.startReceiver(
                permissionResult = resultData,
                preset = preset,
                iceConfigJson = iceConfig,
                controllerDeviceId = controllerDeviceId
            )
            flushPendingSignals(sessionId)
            AuditLogger.log(
                "SCREEN",
                "CAPTURE_STARTED",
                "MediaProjection screen capture and WebRTC sender started after owner approval.",
                AuditSeverity.SECURITY
            )
        } catch (error: Exception) {
            _streamState.value = ScreenStreamState.Error(
                error.message ?: "Could not start the screen-sharing session."
            )
            stopCurrentWebRtcSession()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    @Synchronized
    private fun dispatchSignal(type: String, rawMessage: String) {
        val manager = webRtcSession
        if (manager == null) {
            pendingSignals.add(type to rawMessage)
            return
        }
        try {
            val root = JSONObject(rawMessage)
            val packetSessionId = root.optString("sessionId")
            if (packetSessionId.isBlank() || packetSessionId != activeSessionId) {
                AuditLogger.log(
                    "SIGNALING",
                    "STALE_MEDIA_SIGNAL_IGNORED",
                    "Ignored a media packet that does not belong to the active receiver session.",
                    AuditSeverity.WARNING
                )
                return
            }
            val payload = root.optJSONObject("payload") ?: root
            when (type) {
                "SDP_OFFER" -> {
                    val sdp = payload.optString("sdp", root.optString("sdp"))
                    if (sdp.isNotBlank()) manager.handleOffer(sdp)
                }
                "ICE_CANDIDATE" -> manager.handleIceCandidate(payload)
                "SESSION_ENDED", "EMERGENCY_DISCONNECT" -> {
                    stopCapture()
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        } catch (error: Exception) {
            AuditLogger.log(
                "SIGNALING",
                "MEDIA_SIGNAL_PARSE_FAILED",
                error.message ?: "Invalid media signaling payload.",
                AuditSeverity.WARNING
            )
        }
    }

    @Synchronized
    private fun flushPendingSignals(expectedSessionId: String) {
        while (true) {
            val next = pendingSignals.poll() ?: break
            val matchesSession = runCatching {
                JSONObject(next.second).optString("sessionId") == expectedSessionId
            }.getOrDefault(false)
            if (matchesSession) {
                dispatchSignal(next.first, next.second)
            }
        }
    }

    private fun stopCurrentWebRtcSession() {
        webRtcSession?.close()
        webRtcSession = null
    }

    private fun stopCapture() {
        stopCurrentWebRtcSession()
        activeSessionId = null
        pendingSignals.clear()
        if (_streamState.value !is ScreenStreamState.Error) {
            _streamState.value = ScreenStreamState.Stopped
        }
        AuditLogger.log(
            "SCREEN",
            "STREAM_STOPPED",
            "Screen sharing session stopped.",
            AuditSeverity.INFO
        )
    }

    private fun buildForegroundNotification(): Notification {
        val stopIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openIntent = Intent(this, MainActivity::class.java)
        val openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Mahi Remote screen sharing")
            .setContentText("Your screen is shared with the controller you approved.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop sharing",
                stopPendingIntent
            )
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mahi Remote screen sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Visible while an approved remote screen-sharing session is active."
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopCapture()
        if (runningInstance === this) runningInstance = null
        super.onDestroy()
    }
}
