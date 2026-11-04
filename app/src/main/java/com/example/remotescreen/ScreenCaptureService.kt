package com.example.remotescreen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.example.MainActivity
import com.example.R
import com.example.security.AuditLogger
import com.example.security.AuditSeverity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ScreenCaptureService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.Default + Job())
    private var metricsJob: Job? = null

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null

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

        fun isStreaming(): Boolean = _streamState.value is ScreenStreamState.Active

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
                val presetName = intent.getStringExtra(EXTRA_PRESET) ?: VideoPreset.BALANCED.name
                val preset = try {
                    VideoPreset.valueOf(presetName)
                } catch (e: Exception) {
                    VideoPreset.BALANCED
                }

                if (resultData != null) {
                    startCapture(resultCode, resultData, preset)
                }
            }
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture(resultCode: Int, resultData: Intent, preset: VideoPreset) {
        // MediaProjection consent alone is not a video stream. This repository
        // currently has no Android WebRTC peer connection, encoder, or RTP sender.
        // Stop here rather than reporting fabricated FPS/bitrate or claiming LIVE.
        _streamState.value = ScreenStreamState.Error(
            "Screen permission was granted, but live WebRTC video transport is not implemented in this build. No screen is being shared."
        )
        AuditLogger.log(
            "SCREEN",
            "STREAM_BLOCKED",
            "MediaProjection consent received; no WebRTC sender exists, so capture was not started.",
            AuditSeverity.WARNING
        )
        stopSelf()
    }

    private fun stopCapture() {
        metricsJob?.cancel()
        metricsJob = null
        try {
            virtualDisplay?.release()
            virtualDisplay = null
            mediaProjection?.stop()
            mediaProjection = null
        } catch (e: Exception) {
            // Ignore clean teardown exceptions.
        }
        if (_streamState.value !is ScreenStreamState.Error) {
            _streamState.value = ScreenStreamState.Stopped
        }
        AuditLogger.log("SCREEN", "STREAM_STOPPED", "Screen capture service stopped", AuditSeverity.INFO)
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
            .setContentTitle("Mahi Remote Screen Active")
            .setContentText("Screen is streaming to authorized Windows operator")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop Sharing",
                stopPendingIntent
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Mahi Remote Screen Streaming",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows persistent status while remote screen is sharing"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }
}
