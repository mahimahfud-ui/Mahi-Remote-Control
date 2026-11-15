package com.example.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

/**
 * Stable device identity backed exclusively by the Android Keystore private key.
 *
 * The public key is X.509 SubjectPublicKeyInfo DER. No private key bytes are exported.
 * Missing or unusable Keystore material is a hard error; it is never replaced with a
 * synthetic fingerprint or JVM-generated identity.
 */
object DeviceIdentity {
    private const val PREF_NAME = "mahi_device_identity"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_FINGERPRINT = "device_fingerprint"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "mahi_remote_identity_key"
    private const val CURVE = "secp256r1"

    data class Identity(
        val deviceId: String,
        val deviceName: String,
        val fingerprint: String,
        val publicKeyBase64: String
    )

    @Synchronized
    fun getOrCreateIdentity(context: Context): Identity {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val existingDeviceId = prefs.getString(KEY_DEVICE_ID, null)
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

        if (!keyStore.containsAlias(KEY_ALIAS)) {
            if (!existingDeviceId.isNullOrBlank()) {
                throw IllegalStateException(
                    "The enrolled device key is missing from Android Keystore. Key recovery or rotation is required."
                )
            }
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            ).apply {
                setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
                setDigests(KeyProperties.DIGEST_SHA256)
            }.build()
            generator.initialize(spec)
            generator.generateKeyPair()
        }

        val certificate = keyStore.getCertificate(KEY_ALIAS)
            ?: throw IllegalStateException("Android Keystore did not return the device public-key certificate.")
        val publicKey = certificate.publicKey
        if (!publicKey.algorithm.equals("EC", ignoreCase = true)) {
            throw IllegalStateException("The Android Keystore device key is not an EC key.")
        }

        val publicKeyDer = publicKey.encoded
            ?: throw IllegalStateException("The Android Keystore did not expose an X.509 public key.")
        val publicKeyBase64 = Base64.encodeToString(publicKeyDer, Base64.NO_WRAP)
        val fingerprint = fingerprintForPublicKey(publicKeyDer)
        val deviceId = existingDeviceId ?: generateDeviceId()

        if (!deviceId.matches(Regex("MAHI-[A-Z0-9]{3}-[A-Z0-9]{8}"))) {
            throw IllegalStateException("Stored device ID does not match the Mahi Remote v1 format.")
        }

        val storedFingerprint = prefs.getString(KEY_FINGERPRINT, null)
        if (!storedFingerprint.isNullOrBlank() && storedFingerprint.startsWith("sha256:") &&
            storedFingerprint != fingerprint) {
            throw IllegalStateException(
                "The stored device fingerprint does not match the Android Keystore key. Device key rotation is required."
            )
        }

        val saved = prefs.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_FINGERPRINT, fingerprint)
            .commit()
        if (!saved) {
            throw IllegalStateException("Could not persist the Android device identifier.")
        }

        val manufacturer = Build.MANUFACTURER.trim().ifBlank { "Android" }
        val model = Build.MODEL.trim().ifBlank { "Device" }
        return Identity(
            deviceId = deviceId,
            deviceName = "$manufacturer $model",
            fingerprint = fingerprint,
            publicKeyBase64 = publicKeyBase64
        )
    }

    private fun generateDeviceId(): String {
        val manufacturerPrefix = Build.MANUFACTURER
            .uppercase()
            .filter { it in 'A'..'Z' || it in '0'..'9' }
            .take(3)
            .padEnd(3, 'X')
        val suffix = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
        return "MAHI-$manufacturerPrefix-$suffix"
    }

    fun fingerprintForPublicKey(publicKeyDer: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
        val hex = digest.joinToString("") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        }
        return "sha256:$hex"
    }

    /** Signs exact challenge bytes using the non-exportable Android Keystore private key. */
    fun signData(data: ByteArray): String? {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val privateKey = keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey ?: return null
            val signer = Signature.getInstance("SHA256withECDSA").apply {
                initSign(privateKey)
                update(data)
            }
            Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
        } catch (_: Exception) {
            null
        }
    }

    fun verifyMessageSignature(data: ByteArray, signatureBase64: String, publicKeyBase64: String): Boolean {
        if (signatureBase64.isBlank() || publicKeyBase64.isBlank()) return false
        return try {
            val publicKeyDer = Base64.decode(publicKeyBase64, Base64.DEFAULT)
            val publicKey = KeyFactory.getInstance("EC")
                .generatePublic(X509EncodedKeySpec(publicKeyDer))
            val signatureBytes = Base64.decode(signatureBase64, Base64.DEFAULT)
            val verifier = Signature.getInstance("SHA256withECDSA").apply {
                initVerify(publicKey)
                update(data)
            }
            verifier.verify(signatureBytes)
        } catch (_: Exception) {
            // Never treat a parse error, unsupported key, or malformed signature as proof.
            false
        }
    }
}
