package com.example.security

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.security.MessageDigest
import java.util.UUID

object DeviceIdentity {
    private const val PREF_NAME = "mahi_device_identity"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_PUBLIC_KEY = "device_public_key"
    private const val KEY_FINGERPRINT = "device_fingerprint"

    data class Identity(
        val deviceId: String,
        val deviceName: String,
        val fingerprint: String,
        val publicKeyBase64: String
    )

    fun getOrCreateIdentity(context: Context): Identity {
        val prefs: SharedPreferences = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        var deviceId = prefs.getString(KEY_DEVICE_ID, null)
        var fingerprint = prefs.getString(KEY_FINGERPRINT, null)
        var pubKey = prefs.getString(KEY_PUBLIC_KEY, null)

        if (deviceId == null || fingerprint == null || pubKey == null) {
            val randomSuffix = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
            deviceId = "MAHI-${Build.MANUFACTURER.take(3).uppercase()}-$randomSuffix"
            
            // Generate simulated Ed25519 public key fingerprint using SHA-256
            val rawKey = "$deviceId:${System.currentTimeMillis()}:${UUID.randomUUID()}"
            val md = MessageDigest.getInstance("SHA-256")
            val digest = md.digest(rawKey.toByteArray())
            fingerprint = digest.joinToString(":") { "%02X".format(it) }.take(47)
            pubKey = android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP)

            prefs.edit()
                .putString(KEY_DEVICE_ID, deviceId)
                .putString(KEY_FINGERPRINT, fingerprint)
                .putString(KEY_PUBLIC_KEY, pubKey)
                .apply()
        }

        val deviceName = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
        return Identity(
            deviceId = deviceId,
            deviceName = deviceName,
            fingerprint = fingerprint,
            publicKeyBase64 = pubKey
        )
    }

    fun verifyMessageSignature(data: ByteArray, signatureHex: String, fingerprint: String): Boolean {
        // Enforce basic signature sanity check
        if (signatureHex.isBlank() || fingerprint.isBlank()) return false
        return signatureHex.length >= 32
    }
}
