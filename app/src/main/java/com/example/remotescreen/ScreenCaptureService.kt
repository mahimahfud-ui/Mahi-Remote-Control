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
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.example.MainActivity
import com.example.R
import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Foreground-service shell for owner-visible screen sharing.
 *
 * This GitHub snapshot does not yet contain the native WebRTC publisher. The service
 * deliberately refuses to report an active stream until a real video track is wired in.
 */
class ScreenCaptureService : Service() {

    companion object {
        const val ACTION_START = "com.example.action.START_STREAM"
        const val ACTION_STOP = "com.example.action.STOP_STREAM"
        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_PRESET = "extra_preset"

        private const val NOTIFICATION_ID = 9021
        private const val CHANNEL_ID = "mahi_remote_screen_channel"

        private val _streamState = MutableStateFlow<ScreenStreamState>(ScreenStreamState.Idle)
        val streamState: StateFlow<ScreenStreamState> = _streamState.asStateFlow()

        fun isStreaming(): Boolean = _streamState.value is ScreenStreamState.Active ||
            _streamState.value is ScreenStreamState.WaitingForController

        fun setStreamState(state: ScreenStreamState) {
            _streamState.value = state
        }

        fun stop(context: Context) {
            val intent = Intent(context, ScreenCaptureService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
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

                if (resultCode != 0 && resultData != null) {
                    startForegroundForSharing()
                    _streamState.value = ScreenStreamState.WaitingForController
                    AuditLogger.log("SCREEN", "CONSENT_GRANTED", "Owner granted Android screen-sharing consent; waiting for an approved controller", AuditSeverity.SECURITY)
                } else {
                    _streamState.value = ScreenStreamState.Error("Android screen-sharing permission result was missing.")
                    stopSelf(startId)
                }
            }
            ACTION_STOP -> {
                AndroidWebRtcSession.stopActive()
                _streamState.value = ScreenStreamState.Stopped
                AuditLogger.log("SCREEN", "STREAM_STOPPED", "Screen sharing stop requested by the owner", AuditSeverity.INFO)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundForSharing() {
        val notification = buildForegroundNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
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
        val openAppIntent = Intent(this, MainActivity::class.java)
        val openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Mahi Remote — screen sharing armed")
            .setContentText("Only an owner-approved session can receive your screen. Tap Stop to revoke sharing.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mahi Remote Screen Sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Owner-visible notification while a remote screen-sharing request is active"
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
    }
}
