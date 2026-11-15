package com.example

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.security.DeviceChallenge
import com.example.security.DeviceChallengeProof
import com.example.security.DeviceIdentity
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented test, which will execute on an Android device.
 *
 * See [testing documentation](http://d.android.com/tools/testing).
 */
@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
  @Test
  fun deviceIdentityUsesAndroidKeystoreAndSignsAChallenge() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val identity = DeviceIdentity.getOrCreateIdentity(context)
    assertTrue(identity.deviceId.matches(Regex("MAHI-[A-Z0-9]{3}-[A-Z0-9]{8}")))
    assertTrue(identity.fingerprint.matches(Regex("sha256:[0-9a-f]{64}")))
    assertTrue(identity.publicKeyBase64.isNotBlank())

    val nonce = java.util.Base64.getUrlEncoder().withoutPadding()
      .encodeToString(ByteArray(32) { it.toByte() })
    val challenge = DeviceChallenge(
      challengeId = java.util.UUID.randomUUID().toString(),
      purpose = "AUTHENTICATE",
      nonce = nonce,
      fingerprint = identity.fingerprint,
      signatureAlgorithm = "SHA256withECDSA",
      expiresAtMs = System.currentTimeMillis() + 60_000L
    )
    assertTrue(DeviceChallengeProof.isValid(
      identity.deviceId, identity.fingerprint, "AUTHENTICATE", challenge
    ))
    val message = DeviceChallengeProof.canonicalMessage(identity.deviceId, challenge)
    val signature = DeviceIdentity.signData(message)
    assertNotNull("Android Keystore must sign the challenge", signature)
    assertTrue(
      DeviceIdentity.verifyMessageSignature(message, signature!!, identity.publicKeyBase64)
    )
    assertFalse(
      DeviceIdentity.verifyMessageSignature("tampered".toByteArray(), signature, identity.publicKeyBase64)
    )
  }

  @Test
  fun useAppContext() {
    // Context of the app under test.
    val appContext = InstrumentationRegistry.getInstrumentation().targetContext
    assertEquals(BuildConfig.APPLICATION_ID, appContext.packageName)
  }
}
