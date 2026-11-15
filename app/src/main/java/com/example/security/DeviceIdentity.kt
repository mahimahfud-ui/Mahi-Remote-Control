package com.example.security

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

object DeviceIdentity {
    private const val PREF_NAME = "mahi_device_identity"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_PUBLIC_KEY = "device_public_key"
    private const val KEY_FINGERPRINT = "device_fingerprint"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "mahi_remote_identity_key"

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

        val keyStore = try {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        } catch (e: Exception) {
            throw IllegalStateException("Android Keystore is unavailable. Refusing an unverifiable device identity.", e)
        }

        val existingKeyMatchesPreferences = runCatching {
            val certificate = keyStore.getCertificate(KEY_ALIAS) ?: return@runCatching false
            val publicKeyBytes = certificate.publicKey.encoded
            val storedBytes = android.util.Base64.decode(pubKey ?: return@runCatching false, android.util.Base64.DEFAULT)
            val digest = MessageDigest.getInstance("SHA-256").digest(publicKeyBytes)
            val expectedFingerprint = digest.joinToString(":") { "%02X".format(it) }
            storedBytes.contentEquals(publicKeyBytes) && fingerprint == expectedFingerprint
        }.getOrDefault(false)

        if (deviceId.isNullOrBlank() || fingerprint.isNullOrBlank() ||
            pubKey.isNullOrBlank() || !existingKeyMatchesPreferences) {
            // Rotate the identifier if the backing key is missing or inconsistent.
            val randomSuffix = UUID.randomUUID().toString().replace("-", "").take(8).uppercase()
            deviceId = "MAHI-" + Build.MANUFACTURER.take(3).uppercase() + "-" + randomSuffix

            try {
                if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
                val keyPairGenerator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
                val parameterSpec = KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                ).apply {
                    setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    setDigests(KeyProperties.DIGEST_SHA256)
                }.build()
                keyPairGenerator.initialize(parameterSpec)
                keyPairGenerator.generateKeyPair()

                val certificate = keyStore.getCertificate(KEY_ALIAS)
                    ?: throw IllegalStateException("Android Keystore did not return an identity certificate.")
                val publicKeyBytes = certificate.publicKey.encoded
                pubKey = android.util.Base64.encodeToString(publicKeyBytes, android.util.Base64.NO_WRAP)

                val digest = MessageDigest.getInstance("SHA-256").digest(publicKeyBytes)
                fingerprint = digest.joinToString(":") { "%02X".format(it) }

                prefs.edit()
                    .putString(KEY_DEVICE_ID, deviceId)
                    .putString(KEY_FINGERPRINT, fingerprint)
                    .putString(KEY_PUBLIC_KEY, pubKey)
                    .apply()
            } catch (e: Exception) {
                throw IllegalStateException("Android Keystore identity could not be created. Refusing an unverifiable device identity.", e)
            }
        }

        val deviceName = Build.MANUFACTURER.replaceFirstChar { it.uppercase() } + " " + Build.MODEL
        return Identity(
            deviceId = deviceId ?: throw IllegalStateException("Device identity ID is unavailable."),
            deviceName = deviceName,
            fingerprint = fingerprint ?: throw IllegalStateException("Device fingerprint is unavailable."),
            publicKeyBase64 = pubKey ?: throw IllegalStateException("Device public key is unavailable.")
        )
    }

    fun signData(data: ByteArray): String? {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val privateKey = keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey ?: return null
            val signature = Signature.getInstance("SHA256withECDSA").apply {
                initSign(privateKey)
                update(data)
            }
            android.util.Base64.encodeToString(signature.sign(), android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    fun verifyMessageSignature(data: ByteArray, signatureBase64: String, publicKeyBase64: String): Boolean {
        if (signatureBase64.isBlank() || publicKeyBase64.isBlank()) return false
        return try {
            val pubKeyBytes = android.util.Base64.decode(publicKeyBase64, android.util.Base64.DEFAULT)
            val keySpec = java.security.spec.X509EncodedKeySpec(pubKeyBytes)
            val keyFactory = java.security.KeyFactory.getInstance("EC")
            val pubKey = keyFactory.generatePublic(keySpec)

            val sigBytes = android.util.Base64.decode(signatureBase64, android.util.Base64.DEFAULT)
            val verifier = Signature.getInstance("SHA256withECDSA").apply {
                initVerify(pubKey)
                update(data)
            }
            verifier.verify(sigBytes)
        } catch (_: Exception) {
            // Invalid keys or signatures must never be accepted as a fallback.
            false
        }
    }
}

