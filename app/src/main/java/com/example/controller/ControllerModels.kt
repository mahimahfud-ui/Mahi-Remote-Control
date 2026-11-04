package com.example.controller

enum class AppRole(val title: String) {
    RECEIVER("Allow Remote Control"),
    CONTROLLER("Control Another Device")
}

data class ControllerSession(
    val sessionId: String,
    val targetDeviceId: String,
    val targetDeviceName: String,
    val targetFingerprint: String,
    val sessionToken: String,
    val connectedAtMillis: Long,
    val screenResolution: String = "unavailable"
)

data class KnownTargetDevice(
    val deviceId: String,
    val name: String,
    val model: String,
    val fingerprint: String,
    val lastConnectedAtMillis: Long,
    val isOnline: Boolean = true
)

data class RemoteTelemetry(
    val batteryPercent: Int = 0,
    val batteryTempC: Float = 0f,
    val storageFree: String = "unavailable",
    val roundTripTimeMs: Int = 0
)

enum class RemoteViewerTab(val title: String) {
    SCREEN("Screen"),
    FILES("Files"),
    APPS("Apps"),
    DIAGNOSTICS("Diagnostics")
}
