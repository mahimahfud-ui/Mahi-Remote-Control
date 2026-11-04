package com.example.remotescreen

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import org.webrtc.*
import java.util.concurrent.Executors

/**
 * Owner-consented Android screen sharing and viewing.
 * ScreenCapturerAndroid is not started until Android's system consent result is received
 * and an owner-approved peer sends an offer.
 */
class AndroidWebRtcSession(
    context: Context,
    private val sendSignal: (String, String, String?) -> Boolean
) {
    companion object {
        @Volatile private var activeInstance: AndroidWebRtcSession? = null
        fun stopActive() { activeInstance?.stop() }
    }

    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor()
    private val egl = EglBase.create()
    private val _remoteVideo = MutableStateFlow<VideoTrack?>(null)
    val remoteVideo: StateFlow<VideoTrack?> = _remoteVideo.asStateFlow()
    private val _status = MutableStateFlow("WebRTC ready")
    val status: StateFlow<String> = _status.asStateFlow()

    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var peerId: String? = null
    private var sessionId: String? = null
    private var receiver = false
    private var permissionData: Intent? = null
    private var pendingOffer: SessionDescription? = null
    private var remoteDescriptionSet = false
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var capturer: ScreenCapturerAndroid? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var localTrack: VideoTrack? = null
    private var preset = VideoPreset.BALANCED
    private var iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
    )

    init {
        activeInstance = this
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .createInitializationOptions()
            )
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
        } catch (error: Exception) {
            _status.value = "WebRTC initialization failed: ${error.message}"
        }
    }

    val eglContext: EglBase.Context get() = egl.eglBaseContext

    fun setIceServers(servers: List<PeerConnection.IceServer>) {
        if (servers.isNotEmpty()) executor.execute { iceServers = servers.toList() }
    }

    fun updatePreset(value: VideoPreset) {
        executor.execute {
            preset = value
            try {
                capturer?.changeCaptureFormat(value.width, value.height, value.fps)
            } catch (error: Exception) {
                _status.value = "Video quality will apply on the next share: ${error.message}"
            }
        }
    }

    fun setScreenConsent(resultCode: Int, resultData: Intent, quality: VideoPreset) {
        if (resultCode != Activity.RESULT_OK) return
        executor.execute {
            permissionData = Intent(resultData)
            preset = quality
            ScreenCaptureService.setStreamState(ScreenStreamState.WaitingForController)
            _status.value = "Screen sharing approved; waiting for the controller"
            pendingOffer?.let { offer -> answerOffer(offer, peerId ?: return@execute) }
        }
    }

    fun startController(id: String, targetId: String, servers: List<PeerConnection.IceServer>) {
        executor.execute {
            stopPeer()
            sessionId = id
            peerId = targetId
            receiver = false
            if (servers.isNotEmpty()) iceServers = servers.toList()
            val connection = createPeer() ?: return@execute
            connection.addTransceiver(
                MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
            )
            _status.value = "Negotiating video connection"
            connection.createOffer(object : SdpObserver {
                override fun onCreateSuccess(desc: SessionDescription) {
                    connection.setLocalDescription(object : SdpObserver {
                        override fun onSetSuccess() { sendDescription("SDP_OFFER", desc, targetId) }
                        override fun onSetFailure(error: String?) { fail("Offer setup failed: $error") }
                        override fun onCreateSuccess(desc: SessionDescription?) {}
                        override fun onCreateFailure(error: String?) {}
                    }, desc)
                }
                override fun onCreateFailure(error: String?) { fail("Offer creation failed: $error") }
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }, MediaConstraints())
        }
    }

    fun onSignal(type: String, sender: String, id: String, payload: JSONObject) {
        executor.execute {
            if (!sessionId.isNullOrBlank() && sessionId != id) return@execute
            if (!peerId.isNullOrBlank() && peerId != sender) return@execute
            sessionId = id
            peerId = sender
            when (type) {
                "SDP_OFFER" -> {
                    val sdp = payload.optString("sdp")
                    if (sdp.isBlank()) return@execute fail("Empty video offer")
                    val offer = SessionDescription(SessionDescription.Type.OFFER, sdp)
                    if (permissionData == null) {
                        pendingOffer = offer
                        _status.value = "Waiting for screen-sharing consent on the receiving phone"
                        sendSignal("STREAM_STATUS", JSONObject()
                            .put("status", "WAITING_FOR_SCREEN_PERMISSION").toString(), sender)
                    } else answerOffer(offer, sender)
                }
                "SDP_ANSWER" -> {
                    val sdp = payload.optString("sdp")
                    if (sdp.isBlank()) return@execute fail("Empty video answer")
                    peer?.setRemoteDescription(object : SdpObserver {
                        override fun onSetSuccess() { remoteDescriptionSet = true; flushCandidates(); _status.value = "Connecting video" }
                        override fun onSetFailure(error: String?) { fail("Answer rejected: $error") }
                        override fun onCreateSuccess(desc: SessionDescription?) {}
                        override fun onCreateFailure(error: String?) {}
                    }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
                }
                "ICE_CANDIDATE" -> {
                    val value = payload.optString("candidate")
                    if (value.isNotBlank()) {
                        val candidate = IceCandidate(
                            payload.optString("sdpMid", "0"),
                            payload.optInt("sdpMLineIndex"),
                            value
                        )
                        if (remoteDescriptionSet) peer?.addIceCandidate(candidate)
                        else pendingCandidates.add(candidate)
                    }
                }
                "STREAM_STATUS" -> _status.value = payload.optString("message", payload.optString("status"))
            }
        }
    }

    private fun answerOffer(offer: SessionDescription, controllerId: String) {
        val data = permissionData ?: return
        val rtcFactory = factory ?: return fail("WebRTC is not available")
        if (peer == null) {
            try {
                val videoSource = rtcFactory.createVideoSource(true)
                val helper = SurfaceTextureHelper.create("MahiScreenCapture", egl.eglBaseContext)
                val screenCapturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
                    override fun onStop() {
                        executor.execute {
                            fail("Android screen sharing was stopped by the device owner")
                            stopPeer()
                            releaseCapture()
                        }
                    }
                })
                screenCapturer.initialize(helper, appContext, videoSource.capturerObserver)
                screenCapturer.startCapture(preset.width, preset.height, preset.fps)
                val track = rtcFactory.createVideoTrack("mahi-screen", videoSource)
                track.setEnabled(true)
                capturer = screenCapturer
                textureHelper = helper
                source = videoSource
                localTrack = track
                permissionData = null
                val connection = createPeer() ?: return
                connection.addTrack(track, listOf("mahi-screen"))
            } catch (error: Exception) {
                fail("Could not start screen capture: ${error.message}")
                return
            }
        }
        receiver = true
        val connection = peer ?: return
        connection.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                flushCandidates()
                connection.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        connection.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() { sendDescription("SDP_ANSWER", answer, controllerId) }
                            override fun onSetFailure(error: String?) { fail("Answer setup failed: $error") }
                            override fun onCreateSuccess(desc: SessionDescription?) {}
                            override fun onCreateFailure(error: String?) {}
                        }, answer)
                    }
                    override fun onCreateFailure(error: String?) { fail("Answer creation failed: $error") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(error: String?) {}
                }, MediaConstraints())
            }
            override fun onSetFailure(error: String?) { fail("Offer rejected: $error") }
            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, offer)
        pendingOffer = null
    }

    private fun createPeer(): PeerConnection? {
        val rtcFactory = factory ?: return fail("WebRTC factory unavailable").let { null }
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        val created = rtcFactory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) { stream.videoTracks.firstOrNull()?.let { _remoteVideo.value = it } }
            override fun onRemoveStream(stream: MediaStream) { _remoteVideo.value = null }
            override fun onDataChannel(channel: DataChannel) { channel.close(); channel.dispose() }
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                (receiver.track() as? VideoTrack)?.let { _remoteVideo.value = it }
            }
            override fun onTrack(transceiver: RtpTransceiver) {
                (transceiver.receiver.track() as? VideoTrack)?.let { _remoteVideo.value = it }
            }
            override fun onIceCandidate(candidate: IceCandidate) {
                val target = peerId ?: return
                sendSignal("ICE_CANDIDATE", JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex).toString(), target)
            }
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        _status.value = "Video connection established"
                        if (receiver) {
                            ScreenCaptureService.setStreamState(
                                ScreenStreamState.Active(StreamMetrics(resolution = "${preset.width}×${preset.height}"), preset)
                            )
                            peerId?.let { sendSignal("STREAM_STATUS", JSONObject().put("status", "VIDEO_CONNECTED").toString(), it) }
                        }
                    }
                    PeerConnection.IceConnectionState.FAILED -> fail("Network path failed; this network may require TURN")
                    PeerConnection.IceConnectionState.DISCONNECTED -> _status.value = "Video connection disconnected"
                    else -> Unit
                }
            }
        })
        peer = created
        return created ?: fail("Could not create WebRTC peer").let { null }
    }

    private fun sendDescription(type: String, desc: SessionDescription, target: String) {
        val payload = JSONObject().put("sdp", desc.description).put("sdpType", desc.type.canonicalForm()).toString()
        if (!sendSignal(type, payload, target)) fail("Could not send $type through signaling")
    }

    private fun flushCandidates() {
        val connection = peer ?: return
        pendingCandidates.toList().forEach { connection.addIceCandidate(it) }
        pendingCandidates.clear()
    }

    private fun fail(message: String) {
        _status.value = message
        if (receiver) ScreenCaptureService.setStreamState(ScreenStreamState.Error(message))
    }

    private fun stopPeer() {
        _remoteVideo.value = null
        remoteDescriptionSet = false
        pendingCandidates.clear()
        try { peer?.close() } catch (_: Exception) {}
        try { peer?.dispose() } catch (_: Exception) {}
        peer = null
    }

    private fun releaseCapture() {
        try { capturer?.stopCapture() } catch (_: Exception) {}
        try { capturer?.dispose() } catch (_: Exception) {}
        try { localTrack?.dispose() } catch (_: Exception) {}
        try { source?.dispose() } catch (_: Exception) {}
        try { textureHelper?.dispose() } catch (_: Exception) {}
        capturer = null; localTrack = null; source = null; textureHelper = null; permissionData = null
    }

    fun stop() {
        executor.execute {
            peerId?.let { sendSignal("EMERGENCY_DISCONNECT", JSONObject().put("reason", "Screen sharing stopped by owner").toString(), it) }
            stopPeer()
            releaseCapture()
            pendingOffer = null; peerId = null; sessionId = null; receiver = false
            _status.value = "Session ended"
            ScreenCaptureService.setStreamState(ScreenStreamState.Stopped)
        }
    }

    fun endFromServer() {
        executor.execute {
            stopPeer()
            releaseCapture()
            pendingOffer = null
            peerId = null
            sessionId = null
            receiver = false
            _status.value = "Remote session ended"
            ScreenCaptureService.setStreamState(ScreenStreamState.Stopped)
        }
    }

    fun close() {
        stop()
        executor.execute { factory?.dispose(); factory = null; egl.release() }
        executor.shutdown()
        if (activeInstance === this) activeInstance = null
    }
}
