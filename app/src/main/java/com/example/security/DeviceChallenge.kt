package com.example.security

import android.content.Context
import java.util.Base64
import java.util.UUID

data class DeviceChallenge(
    val challengeId: String,
    val purpose: String,
    val nonce: String,
    val fingerprint: String,
    val signatureAlgorithm: String,
    val expiresAtMs: Long
)

/** Pure protocol-v1 challenge validation and canonical signing-message construction. */
object DeviceChallengeProof {
    private const val MAX_CHALLENGE_TTL_MS = 120_000L
    private val challengeIdPattern = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )
    private val noncePattern = Regex("^[A-Za-z0-9_-]{43}$")
    private val fingerprintPattern = Regex("^sha256:[0-9a-f]{64}$")

    fun canonicalMessage(deviceId: String, challenge: DeviceChallenge): ByteArray {
        val message = listOf(
            "MAHI-REMOTE-DEVICE-PROOF",
            "1",
            challenge.purpose,
            challenge.challengeId,
            deviceId,
            challenge.fingerprint,
            challenge.nonce,
            challenge.expiresAtMs.toString()
        ).joinToString("\n")
        return message.toByteArray(Charsets.UTF_8)
    }

    fun isValid(
        deviceId: String,
        expectedFingerprint: String,
        expectedPurpose: String,
        challenge: DeviceChallenge,
        nowMillis: Long = System.currentTimeMillis()
    ): Boolean {
        if (!deviceId.matches(Regex("MAHI-[A-Z0-9]{3}-[A-Z0-9]{8}"))) return false
        if (expectedPurpose !in setOf("ENROLL", "AUTHENTICATE", "ROTATE")) return false
        if (challenge.purpose != expectedPurpose) return false
        if (!challengeIdPattern.matches(challenge.challengeId)) return false
        val canonicalId = runCatching { UUID.fromString(challenge.challengeId).toString() }.getOrNull()
        if (canonicalId == null || !canonicalId.equals(challenge.challengeId, ignoreCase = true)) return false
        if (challenge.fingerprint != expectedFingerprint || !fingerprintPattern.matches(challenge.fingerprint)) return false
        if (challenge.signatureAlgorithm != "SHA256withECDSA") return false

        val remaining = challenge.expiresAtMs - nowMillis
        if (remaining !in 1..MAX_CHALLENGE_TTL_MS) return false

        if (!noncePattern.matches(challenge.nonce)) return false
        val nonceBytes = runCatching { Base64.getUrlDecoder().decode(challenge.nonce) }.getOrNull()
            ?: return false
        if (nonceBytes.size != 32) return false
        val encodedAgain = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes)
        return encodedAgain == challenge.nonce
    }
}

/**
 * Local defense-in-depth against a challenge ID being submitted twice by this client.
 * The backend remains authoritative for atomic one-time consumption and replay rejection.
 */
class DeviceChallengeReplayGuard(context: Context) {
    private val preferences = context.getSharedPreferences(
        "mahi_remote_consumed_device_challenges",
        Context.MODE_PRIVATE
    )

    @Synchronized
    fun consume(challengeId: String): Boolean {
        if (challengeId.isBlank()) return false
        val stored = preferences.getStringSet("ids", emptySet()) ?: emptySet()
        if (challengeId in stored) return false

        val updated = LinkedHashSet(stored)
        updated.add(challengeId)
        while (updated.size > 128) {
            val oldest = updated.firstOrNull() ?: break
            updated.remove(oldest)
        }
        return preferences.edit().putStringSet("ids", updated).commit()
    }
}
