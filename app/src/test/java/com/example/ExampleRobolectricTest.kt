package com.example

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.filetransfer.FileManager
import com.example.pairing.PairingManager
import com.example.security.AllowlistValidator
import com.example.security.DeviceIdentity
import com.example.security.DeviceChallenge
import com.example.security.DeviceChallengeProof
import com.example.security.DeviceChallengeReplayGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExampleRobolectricTest {


    private fun testIdentity() = DeviceIdentity.Identity(
        deviceId = "MAHI-TST-12345678",
        deviceName = "Mahi Remote Test Device",
        fingerprint = "sha256:" + "a".repeat(64),
        publicKeyBase64 = "AA=="
    )


    @Test
    fun testAppNameResource() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val appName = context.getString(R.string.app_name)
        assertEquals("Mahi Remote", appName)
    }

    @Test
    fun testPublicKeyFingerprintUsesProtocolV1Format() {
        val generator = java.security.KeyPairGenerator.getInstance("EC")
        generator.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        val publicKeyDer = generator.generateKeyPair().public.encoded

        val fingerprint = DeviceIdentity.fingerprintForPublicKey(publicKeyDer)
        assertTrue(fingerprint.matches(Regex("sha256:[0-9a-f]{64}")))
        assertEquals(fingerprint, DeviceIdentity.fingerprintForPublicKey(publicKeyDer))
    }

    @Test
    fun testAllowlistValidatorBounds() {
        // Within bounds
        val validTap = AllowlistValidator.validateTap(500f, 1000f, 1080, 2400)
        assertTrue(validTap is AllowlistValidator.ValidationResult.Valid)

        // Out of bounds
        val invalidTap = AllowlistValidator.validateTap(-10f, 1000f, 1080, 2400)
        assertTrue(invalidTap is AllowlistValidator.ValidationResult.Rejected)

        // Prohibited shell command
        val shellTest = AllowlistValidator.validateRawCommand("rm -rf /")
        assertTrue(shellTest is AllowlistValidator.ValidationResult.Rejected)

        // Valid swipe
        val validSwipe = AllowlistValidator.validateSwipe(100f, 200f, 300f, 800f, 300L, 1080, 2400)
        assertTrue(validSwipe is AllowlistValidator.ValidationResult.Valid)

        // Invalid swipe duration
        val invalidDuration = AllowlistValidator.validateSwipe(100f, 200f, 300f, 800f, 10L, 1080, 2400)
        assertTrue(invalidDuration is AllowlistValidator.ValidationResult.Rejected)
    }

    @Test
    fun testPairingCodeAndSessionLifecycle() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = PairingManager(context, testIdentity())
        val codeData = manager.generateNewPairingCode()

        assertNotNull(codeData.code)
        assertEquals(7, codeData.code.length) // "XXX-XXX"
        assertTrue(codeData.expiresAtMillis > System.currentTimeMillis())

        manager.recordIncomingOperatorRequest(
            controllerId = "browser-controller-1",
            operatorName = "Remote Support Operator",
            location = "Remote",
            fingerprint = "8E:4A:91:D2:11:F9:6C:55:A3:40:99:BC:14:8A:EF:29",
            scopes = listOf("Screen Mirroring", "Remote Interaction"),
            requestId = "req-1"
        )

        val pending = manager.pendingRequest.value
        assertNotNull(pending)
        manager.approveRequest(pending!!)
        assertTrue(manager.approvalInProgress.value)

        // Owner approval is not a session until the backend issues authorization.
        assertEquals(null, manager.activeSession.value)
        assertTrue(manager.markSessionAuthorized("test-session-1"))

        val active = manager.activeSession.value
        assertNotNull(active)
        assertEquals("Remote Support Operator", active?.operatorName)

        manager.emergencyDisconnect("Test disconnect")
        assertEquals(null, manager.activeSession.value)
    }

    @Test
    fun testFileManagerTwoWayTransferAndSha256() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val fileManager = FileManager(context)

        val testDir = context.filesDir.absolutePath
        val testFile = File(testDir, "test_document.txt")
        testFile.delete()

        // 1. Write chunk
        val sampleData = "Hello from Mahi Remote Windows Controller!".toByteArray()
        val writeOk = fileManager.writeFileChunk(testFile.absolutePath, sampleData, append = false)
        assertTrue("Write chunk failed", writeOk)
        assertTrue(testFile.exists())

        // 2. Read chunk back
        val readBytes = fileManager.readFileChunk(testFile.absolutePath, 0, sampleData.size)
        assertNotNull(readBytes)
        assertEquals("Hello from Mahi Remote Windows Controller!", String(readBytes!!))

        // 3. Verify SHA-256 calculation
        val checksum = fileManager.calculateSha256(testFile.absolutePath)
        assertNotNull(checksum)
        assertEquals(64, checksum?.length) // 64 hex chars

        // 4. Create folder
        val folderOk = fileManager.createFolder(testDir, "TestLogs")
        assertTrue("Folder creation failed", folderOk)
        val createdFolder = File(testDir, "TestLogs")
        assertTrue(createdFolder.isDirectory)

        // Chunk offsets and sizes must be bounded before allocating or writing buffers.
        assertNull(fileManager.readFileChunk(testFile.absolutePath, -1L, 1))
        assertNull(fileManager.readFileChunk(testFile.absolutePath, 0L, FileManager.MAX_CHUNK_BYTES + 1))
        assertFalse(
            fileManager.writeFileChunk(
                testFile.absolutePath,
                ByteArray(FileManager.MAX_CHUNK_BYTES + 1),
                append = true
            )
        )

        // 5. Delete file
        val deleteOk = fileManager.deleteFile(testFile.absolutePath, confirmed = true)
        assertTrue("File deletion failed", deleteOk)
        assertFalse(testFile.exists())
    }

    @Test
    fun testAndroidToAndroidRoleAndControllerSession() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = PairingManager(context, testIdentity())

        // Simulate incoming pairing request from an Android Phone controller
        manager.recordIncomingOperatorRequest(
            controllerId = "MAHI-PHONE-A-CONTROLLER",
            operatorName = "Phone A (Pixel 8 Pro)",
            location = "Sylhet NOC",
            fingerprint = "AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00",
            scopes = listOf("Screen Mirroring", "Remote Interaction", "File Transfer")
        )

        val pending = manager.pendingRequest.value
        assertNotNull(pending)
        assertEquals("MAHI-PHONE-A-CONTROLLER", pending?.controllerId)
        assertEquals("Phone A (Pixel 8 Pro)", pending?.operatorName)

        // Approve, but do not activate until the backend confirms the session.
        manager.approveRequest(pending!!)
        assertTrue(manager.approvalInProgress.value)
        assertEquals(null, manager.activeSession.value)
        assertTrue(manager.markSessionAuthorized("android-session-1"))
        assertNotNull(manager.activeSession.value)
        assertEquals("Phone A (Pixel 8 Pro)", manager.activeSession.value?.operatorName)

        // Emergency disconnect terminates cleanly
        manager.emergencyDisconnect("Emergency Stop triggered")
        assertEquals(null, manager.activeSession.value)
    }    
    @Test
    fun testSessionCannotBeActivatedWithoutApprovedRequest() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = PairingManager(context, testIdentity())

        assertFalse(manager.markSessionAuthorized("forged-session-id"))
        assertEquals(null, manager.activeSession.value)
        assertFalse(manager.approvalInProgress.value)
    }



    @Test
    fun testChallengeCanonicalMessageAndReplayProtection() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val nonce = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32) { it.toByte() })
        val challenge = DeviceChallenge(
            challengeId = java.util.UUID.randomUUID().toString(),
            purpose = "AUTHENTICATE",
            nonce = nonce,
            fingerprint = "sha256:" + "a".repeat(64),
            signatureAlgorithm = "SHA256withECDSA",
            expiresAtMs = 121_000L
        )

        assertTrue(
            DeviceChallengeProof.isValid(
                "MAHI-TST-12345678",
                "sha256:" + "a".repeat(64),
                "AUTHENTICATE",
                challenge,
                nowMillis = 1_000L
            )
        )
        val canonical = String(
            DeviceChallengeProof.canonicalMessage("MAHI-TST-12345678", challenge),
            Charsets.UTF_8
        )
        assertEquals(
            "MAHI-REMOTE-DEVICE-PROOF\n1\nAUTHENTICATE\n" + challenge.challengeId + "\nMAHI-TST-12345678\nsha256:" + "a".repeat(64) + "\n" + nonce + "\n121000",
            canonical
        )

        val replayGuard = DeviceChallengeReplayGuard(context)
        assertTrue(replayGuard.consume(challenge.challengeId))
        assertFalse(replayGuard.consume(challenge.challengeId))

        val expired = challenge.copy(expiresAtMs = 999L)
        assertFalse(
            DeviceChallengeProof.isValid(
                "MAHI-TST-12345678",
                challenge.fingerprint,
                "AUTHENTICATE",
                expired,
                nowMillis = 1_000L
            )
        )
        assertFalse(
            DeviceChallengeProof.isValid(
                "MAHI-TST-12345678",
                challenge.fingerprint,
                "AUTHENTICATE",
                challenge.copy(nonce = challenge.nonce + "="),
                nowMillis = 1_000L
            )
        )
        assertFalse(
            DeviceChallengeProof.isValid(
                "MAHI-TST-12345678",
                challenge.fingerprint,
                "ENROLL",
                challenge,
                nowMillis = 1_000L
            )
        )
    }


    @Test
    fun testRejectedPairingCannotEstablishSession() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = PairingManager(context, testIdentity())
        manager.recordIncomingOperatorRequest(
            controllerId = "controller-rejected",
            operatorName = "Rejected Controller",
            location = "Remote",
            fingerprint = "AA:BB:CC:DD",
            scopes = listOf("Screen Mirroring"),
            requestId = "rejected-request"
        )

        val pending = manager.pendingRequest.value
        assertNotNull(pending)
        manager.rejectRequest(pending!!)

        assertNull(manager.pendingRequest.value)
        assertNull(manager.activeSession.value)
        assertFalse(manager.approvalInProgress.value)
        assertFalse(manager.markSessionAuthorized("late-backend-session"))
        assertNull(manager.activeSession.value)
    }

    @Test
    fun testDeviceSignatureVerificationFailsClosed() {
        val generator = java.security.KeyPairGenerator.getInstance("EC")
        generator.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        val keyPair = generator.generateKeyPair()
        val challenge = "one-time-backend-challenge".toByteArray()
        val signer = java.security.Signature.getInstance("SHA256withECDSA").apply {
            initSign(keyPair.private)
            update(challenge)
        }
        val validSignature = java.util.Base64.getEncoder().encodeToString(signer.sign())
        val validPublicKey = java.util.Base64.getEncoder().encodeToString(keyPair.public.encoded)

        assertTrue(DeviceIdentity.verifyMessageSignature(challenge, validSignature, validPublicKey))
        assertFalse(
            DeviceIdentity.verifyMessageSignature(
                "different-challenge".toByteArray(),
                validSignature,
                validPublicKey
            )
        )

        // A long malformed signature previously passed the exception fallback.
        assertFalse(
            DeviceIdentity.verifyMessageSignature(
                challenge,
                "A".repeat(128),
                java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3))
            )
        )
    }

    @Test
    fun testFilePathValidationRejectsTraversalAndSiblingPrefix() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val allowedRoot = File(context.cacheDir, "allowed-root").apply { mkdirs() }
        val allowedFile = File(allowedRoot, "nested/document.txt")
        val siblingPrefix = File(context.cacheDir, "allowed-root-escape/secret.txt")
        val traversal = File(allowedRoot, "../allowed-root-escape/secret.txt")

        assertTrue(
            AllowlistValidator.validateFilePath(
                allowedFile.absolutePath,
                listOf(allowedRoot.absolutePath)
            ) is AllowlistValidator.ValidationResult.Valid
        )
        assertTrue(
            AllowlistValidator.validateFilePath(
                siblingPrefix.absolutePath,
                listOf(allowedRoot.absolutePath)
            ) is AllowlistValidator.ValidationResult.Rejected
        )
        assertTrue(
            AllowlistValidator.validateFilePath(
                traversal.path,
                listOf(allowedRoot.absolutePath)
            ) is AllowlistValidator.ValidationResult.Rejected
        )
    }

}
