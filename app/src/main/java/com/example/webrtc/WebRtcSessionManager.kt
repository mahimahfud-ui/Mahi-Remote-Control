package com.example.webrtc

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.util.DisplayMetrics
import android.view.WindowManager
import com.example.remotescreen.VideoPreset
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Shared WebRTC runtime and one-to-one media session.
 *
 * Create this class only after the signaling server has approved the pairing
 * and issued a signed session token. The backend authorizes signaling messages;
 * this class handles only the media plane.
 */
class WebRtcSessionManager(
    context: Context,
    private val sendSignal: (type: String, payload: String, recipient: String?) -> Boolean,
    private val onRemoteVideoTrack: (VideoTrack) -> Unit = {},
    private val onFirstRemoteFrame: () -> Unit = {},
    private val onConnectionState: (PeerConnection.PeerConnectionState) -> Unit = {},
    private val onError: (String) -> Unit = {}
) {
    private data class RuntimeParts(
        val egl: EglBase,
        val factory: PeerConnectionFactory
    )

    private object Runtime {
        private val lock = Any()
        @Volatile private var value: RuntimeParts? = null

        fun get(context: Context): RuntimeParts {
            value?.let { return it }
            synchronized(lock) {
                value?.let { return it }
                val egl = EglBase.create()
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions
                        .builder(context.applicationContext)
                        .createInitializationOptions()
                )
                val factory = PeerConnectionFactory.builder()
                    .setVideoEncoderFactory(
                        DefaultVideoEncoderFactory(egl.eglBaseContext, true, true)
                    )
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                    .createPeerConnectionFactory()
                return RuntimeParts(egl, factory).also { value = it }
            }
        }
    }

    private val appContext = context.applicationContext
    private val runtime = Runtime.get(appContext)
    private val eglBase = runtime.egl
    private val peerFactory = runtime.factory

    private var peerConnection: PeerConnection? = null
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var localVideoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var remoteVideoTrack: VideoTrack? = null
    private var firstFrameSink: VideoSink? = null
    private var remoteRenderer: SurfaceViewRenderer? = null
    private val pendingIceCandidates = mutableListOf<IceCandidate>()
    private val closed = AtomicBoolean(false)
    private val firstFrameReported = AtomicBoolean(false)

    @Volatile private var remoteDescriptionSet = false
    @Volatile private var targetDeviceId: String? = null

    private fun parseIceServers(configJson: String): List<PeerConnection.IceServer> {
        val root = JSONObject(configJson)
        val array = root.optJSONArray("iceServers") ?: JSONArray()
        val result = mutableListOf<PeerConnection.IceServer>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val rawUrls = item.opt("urls")
            val urls = when (rawUrls) {
                is String -> listOf(rawUrls)
                is JSONArray -> (0 until rawUrls.length())
                    .mapNotNull { rawUrls.optString(it).takeIf { value -> value.isNotBlank() } }
                else -> emptyList()
            }
            if (urls.isEmpty()) continue

            val builder = PeerConnection.IceServer.builder(urls)
            val username = item.optString("username")
            val credential = item.optString("credential")
            if (username.isNotBlank()) builder.setUsername(username)
            if (credential.isNotBlank()) builder.setPassword(credential)
            result.add(builder.createIceServer())
        }
        check(result.isNotEmpty()) { "No usable ICE servers were returned by the backend." }
        return result
    }

    @Synchronized
    private fun ensurePeerConnection(iceConfigJson: String) {
        check(!closed.get()) { "This WebRTC session has already been closed." }
        if (peerConnection != null) return

        val configuration = PeerConnection.RTCConfiguration(parseIceServers(iceConfigJson)).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = peerFactory.createPeerConnection(
            configuration,
            object : PeerConnection.Observer {
                override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
                override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
                override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) = Unit
                override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
                override fun onAddStream(stream: MediaStream) {
                    stream.videoTracks.firstOrNull()?.let(::acceptRemoteTrack)
                }
                override fun onRemoveStream(stream: MediaStream) = Unit
                override fun onDataChannel(channel: DataChannel) = Unit
                override fun onRenegotiationNeeded() = Unit

                override fun onIceCandidate(candidate: IceCandidate) {
                    val payload = JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex)
                        .toString()
                    sendSignal("ICE_CANDIDATE", payload, targetDeviceId)
                }

                override fun onTrack(transceiver: RtpTransceiver) {
                    (transceiver.receiver.track() as? VideoTrack)?.let(::acceptRemoteTrack)
                }

                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                    onConnectionState(newState)
                    if (newState == PeerConnection.PeerConnectionState.FAILED) {
                        onError("WebRTC connection failed. Check the internet path and TURN relay.")
                    }
                }
            }
        ) ?: throw IllegalStateException("PeerConnectionFactory could not create a PeerConnection.")
    }

    private fun acceptRemoteTrack(track: VideoTrack) {
        if (remoteVideoTrack === track) return
        remoteVideoTrack?.let { previous ->
            firstFrameSink?.let(previous::removeSink)
            remoteRenderer?.let(previous::removeSink)
        }
        remoteVideoTrack = track

        val sink = VideoSink { frame ->
            if (firstFrameReported.compareAndSet(false, true)) {
                onFirstRemoteFrame()
            }
        }
        firstFrameSink = sink
        track.addSink(sink)
        remoteRenderer?.let(track::addSink)
        onRemoteVideoTrack(track)
    }

    fun initializeRenderer(renderer: SurfaceViewRenderer) {
        renderer.init(eglBase.eglBaseContext, null)
        renderer.setEnableHardwareScaler(true)
        renderer.setMirror(false)
        renderer.setScalingType(org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        remoteRenderer?.let { old ->
            remoteVideoTrack?.removeSink(old)
            old.release()
        }
        remoteRenderer = renderer
        remoteVideoTrack?.addSink(renderer)
    }

    fun releaseRenderer(renderer: SurfaceViewRenderer) {
        remoteVideoTrack?.removeSink(renderer)
        if (remoteRenderer === renderer) remoteRenderer = null
        renderer.release()
    }

    fun startController(iceConfigJson: String, receiverDeviceId: String) {
        targetDeviceId = receiverDeviceId
        ensurePeerConnection(iceConfigJson)

        val transceiverInit = RtpTransceiver.RtpTransceiverInit(
            RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
        )
        peerConnection?.addTransceiver(
            org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
            transceiverInit
        ) ?: throw IllegalStateException("Unable to create receive-only video transceiver.")

        peerConnection?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                val connection = peerConnection ?: return
                connection.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        sendSignal(
                            "SDP_OFFER",
                            JSONObject().put("sdp", description.description).toString(),
                            targetDeviceId
                        )
                    }
                    override fun onSetFailure(error: String) {
                        onError("Could not set local SDP offer: " + error)
                    }
                    override fun onCreateSuccess(description: SessionDescription) = Unit
                    override fun onCreateFailure(error: String) = Unit
                }, description)
            }
            override fun onCreateFailure(error: String) {
                onError("Could not create SDP offer: " + error)
            }
            override fun onSetSuccess() = Unit
            override fun onSetFailure(error: String) {
                onError("Could not create SDP offer: " + error)
            }
        }, MediaConstraints()) ?: onError("PeerConnection is unavailable.")
    }

    fun startReceiver(
        permissionResult: Intent,
        preset: VideoPreset,
        iceConfigJson: String,
        controllerDeviceId: String
    ) {
        targetDeviceId = controllerDeviceId
        ensurePeerConnection(iceConfigJson)

        val capturer = ScreenCapturerAndroid(
            permissionResult,
            object : MediaProjection.Callback() {
                override fun onStop() {
                    onError("Android stopped screen sharing.")
                    close()
                }
            }
        )
        screenCapturer = capturer

        val source = peerFactory.createVideoSource(true)
        localVideoSource = source
        val helper = org.webrtc.SurfaceTextureHelper.create(
            "MahiScreenCapture",
            eglBase.eglBaseContext
        ) ?: throw IllegalStateException("Could not create screen capture texture helper.")
        capturer.initialize(helper, appContext, source.capturerObserver)

        val track = peerFactory.createVideoTrack(
            "mahi-screen-" + System.currentTimeMillis(),
            source
        ) ?: throw IllegalStateException("Could not create the screen video track.")
        localVideoTrack = track
        track.setEnabled(true)

        peerConnection?.addTrack(track, listOf("mahi-screen-stream"))
            ?: throw IllegalStateException("Could not add the screen track to WebRTC.")

        val metrics = DisplayMetrics()
        val windowManager = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealMetrics(metrics)

        val landscape = metrics.widthPixels > metrics.heightPixels
        val desiredWidth = if (landscape) preset.height else preset.width
        val desiredHeight = if (landscape) preset.width else preset.height
        val scale = minOf(
            1f,
            desiredWidth.toFloat() / metrics.widthPixels.coerceAtLeast(1),
            desiredHeight.toFloat() / metrics.heightPixels.coerceAtLeast(1)
        )
        val width = (metrics.widthPixels * scale).toInt().coerceAtLeast(2).let { it - (it % 2) }
        val height = (metrics.heightPixels * scale).toInt().coerceAtLeast(2).let { it - (it % 2) }
        capturer.startCapture(width, height, preset.fps)
    }

    fun handleOffer(sdp: String) {
        val connection = peerConnection ?: run {
            onError("Screen sender is not active; cannot accept an SDP offer.")
            return
        }
        val offer = SessionDescription(SessionDescription.Type.OFFER, sdp)
        connection.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                flushIceCandidates()
                connection.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        connection.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() {
                                sendSignal(
                                    "SDP_ANSWER",
                                    JSONObject().put("sdp", description.description).toString(),
                                    targetDeviceId
                                )
                            }
                            override fun onSetFailure(error: String) {
                                onError("Could not set local SDP answer: " + error)
                            }
                            override fun onCreateSuccess(description: SessionDescription) = Unit
                            override fun onCreateFailure(error: String) = Unit
                        }, description)
                    }
                    override fun onCreateFailure(error: String) {
                        onError("Could not create SDP answer: " + error)
                    }
                    override fun onSetSuccess() = Unit
                    override fun onSetFailure(error: String) {
                        onError("Could not create SDP answer: " + error)
                    }
                }, MediaConstraints())
            }
            override fun onSetFailure(error: String) {
                onError("Could not set remote SDP offer: " + error)
            }
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onCreateFailure(error: String) = Unit
        }, offer)
    }

    fun handleAnswer(sdp: String) {
        val connection = peerConnection ?: return
        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        connection.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                flushIceCandidates()
            }
            override fun onSetFailure(error: String) {
                onError("Could not set remote SDP answer: " + error)
            }
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onCreateFailure(error: String) = Unit
        }, answer)
    }

    fun handleIceCandidate(payload: JSONObject) {
        val candidateText = payload.optString("candidate")
        if (candidateText.isBlank()) return
        val sdpMid = payload.optString("sdpMid").takeIf { it.isNotBlank() }
        val lineIndex = payload.optInt("sdpMLineIndex", 0)
        val candidate = IceCandidate(sdpMid, lineIndex, candidateText)
        if (remoteDescriptionSet) {
            peerConnection?.addIceCandidate(candidate)
        } else {
            synchronized(pendingIceCandidates) {
                pendingIceCandidates.add(candidate)
            }
        }
    }

    private fun flushIceCandidates() {
        val connection = peerConnection ?: return
        synchronized(pendingIceCandidates) {
            pendingIceCandidates.forEach { connection.addIceCandidate(it) }
            pendingIceCandidates.clear()
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            screenCapturer?.stopCapture()
        } catch (_: Exception) {
            // The projection may already have been stopped by Android.
        }
        screenCapturer?.dispose()
        screenCapturer = null
        remoteVideoTrack?.let { track ->
            firstFrameSink?.let(track::removeSink)
            remoteRenderer?.let(track::removeSink)
            track.dispose()
        }
        remoteVideoTrack = null
        firstFrameSink = null
        remoteRenderer = null
        localVideoTrack?.dispose()
        localVideoTrack = null
        localVideoSource?.dispose()
        localVideoSource = null
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null
    }
}
