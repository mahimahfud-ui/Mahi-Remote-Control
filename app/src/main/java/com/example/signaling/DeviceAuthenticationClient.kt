package com.example.signaling

import android.content.Context
import com.example.BuildConfig
import com.example.security.DeviceChallenge
import com.example.security.DeviceChallengeProof
import com.example.security.DeviceChallengeReplayGuard
import com.example.security.DeviceIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class DeviceAccessToken(
    val value: String,
    val expiresAtMillis: Long
)

/**
 * Implements the exact v1 device enrollment/authentication REST contract.
 * Access tokens remain memory-only and are sent only in the receiver WebSocket handshake.
 */
class DeviceAuthenticationClient(
    context: Context,
    private val identity: DeviceIdentity.Identity,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
) {
    companion object {
        private const val PROTOCOL_VERSION = 1
        private const val VERSION_HEADER = "X-Mahi-Protocol-Version"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }

    private val replayGuard = DeviceChallengeReplayGuard(context)
    private val baseUrl = BuildConfig.PUBLIC_BASE_URL.trim().trimEnd('/')

    private data class ApiResponse(val statusCode: Int, val body: JSONObject)
    private class ApiFailure(
        val statusCode: Int,
        val errorCode: String,
        message: String
    ) : IllegalStateException("Device authentication failed ($statusCode/$errorCode): $message")

    suspend fun authenticate(): DeviceAccessToken = withContext(Dispatchers.IO) {
        if (!baseUrl.startsWith("https://", ignoreCase = true)) {
            throw IllegalStateException("Mahi Remote v1 device authentication requires an HTTPS backend URL.")
        }

        val challengeResponse = try {
            post(
                "/api/v1/devices/auth/challenges",
                JSONObject()
                    .put("protocolVersion", PROTOCOL_VERSION)
                    .put("deviceId", identity.deviceId)
            )
        } catch (failure: ApiFailure) {
            if (failure.statusCode != 404 || failure.errorCode != "DEVICE_NOT_FOUND") throw failure
            return@withContext enrollNewDevice()
        }

        completeProof(
            challengeResponse.body,
            expectedPurpose = "AUTHENTICATE",
            verifyPath = "/api/v1/devices/auth/verify"
        )
    }

    private fun enrollNewDevice(): DeviceAccessToken {
        val publicKey = JSONObject()
            .put("format", "spki-der-base64")
            .put("algorithm", "EC")
            .put("curve", "P-256")
            .put("value", identity.publicKeyBase64)

        val response = post(
            "/api/v1/devices/enrollment/challenges",
            JSONObject()
                .put("protocolVersion", PROTOCOL_VERSION)
                .put("deviceId", identity.deviceId)
                .put("deviceName", identity.deviceName)
                .put("publicKey", publicKey)
        )
        return completeProof(
            response.body,
            expectedPurpose = "ENROLL",
            verifyPath = "/api/v1/devices/enrollment/verify"
        )
    }

    private fun completeProof(
        responseBody: JSONObject,
        expectedPurpose: String,
        verifyPath: String
    ): DeviceAccessToken {
        val challenge = DeviceChallenge(
            challengeId = responseBody.optString("challengeId"),
            purpose = responseBody.optString("purpose"),
            nonce = responseBody.optString("nonce"),
            fingerprint = responseBody.optString("fingerprint"),
            signatureAlgorithm = responseBody.optString("signatureAlgorithm"),
            expiresAtMs = responseBody.optLong("expiresAtMs", -1L)
        )

        if (!DeviceChallengeProof.isValid(
                deviceId = identity.deviceId,
                expectedFingerprint = identity.fingerprint,
                expectedPurpose = expectedPurpose,
                challenge = challenge
            )
        ) {
            throw IllegalStateException("Backend returned an invalid or expired $expectedPurpose device challenge.")
        }

        // Persist challenge consumption before signing/submitting it; retries must obtain a fresh nonce.
        if (!replayGuard.consume(challenge.challengeId)) {
            throw IllegalStateException("Device challenge was already used or could not be recorded locally.")
        }

        val proofBytes = DeviceChallengeProof.canonicalMessage(identity.deviceId, challenge)
        val signature = DeviceIdentity.signData(proofBytes)
            ?: throw IllegalStateException("Android Keystore could not sign the device challenge; authentication was stopped.")

        val verified = post(
            verifyPath,
            JSONObject()
                .put("protocolVersion", PROTOCOL_VERSION)
                .put("challengeId", challenge.challengeId)
                .put("signature", signature)
        ).body

        val deviceId = verified.optString("deviceId")
        val fingerprint = verified.optString("fingerprint")
        val token = verified.optString("deviceAccessToken")
        val tokenType = verified.optString("tokenType")
        val expiresInSeconds = verified.optLong("expiresInSeconds", -1L)

        if (deviceId != identity.deviceId ||
            fingerprint != identity.fingerprint ||
            token.isBlank() ||
            tokenType != "Bearer" ||
            expiresInSeconds !in 1..900
        ) {
            throw IllegalStateException("Backend returned an invalid device access-token response.")
        }

        return DeviceAccessToken(
            value = token,
            expiresAtMillis = System.currentTimeMillis() + expiresInSeconds * 1000L
        )
    }

    private fun post(path: String, body: JSONObject): ApiResponse {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header(VERSION_HEADER, PROTOCOL_VERSION.toString())
            .header("Accept", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        httpClient.newCall(request).execute().use { response ->
            val responseText = response.body?.string().orEmpty()
            val json = try {
                JSONObject(responseText)
            } catch (_: Exception) {
                throw IllegalStateException("Backend returned a non-JSON v1 device-authentication response.")
            }

            if (response.header(VERSION_HEADER) != PROTOCOL_VERSION.toString() ||
                json.optInt("protocolVersion", -1) != PROTOCOL_VERSION
            ) {
                throw IllegalStateException("Backend did not confirm Mahi Remote protocol version 1.")
            }

            if (!response.isSuccessful) {
                val code = json.optJSONObject("error")?.optString("code").orEmpty()
                val message = json.optJSONObject("error")?.optString("message")
                    ?: json.optString("error", response.message)
                throw ApiFailure(response.code, code, message)
            }

            return ApiResponse(response.code, json)
        }
    }
}
