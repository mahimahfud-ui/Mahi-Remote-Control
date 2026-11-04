package com.example.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.BrightnessMedium
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ScreenShare
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Tab
import androidx.compose.material.icons.filled.VolumeDown
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.controller.RemoteViewerTab
import com.example.ui.MahiViewModel
import org.webrtc.SurfaceViewRenderer
import com.example.ui.theme.CyanAccent
import com.example.ui.theme.DarkCharcoalBg
import com.example.ui.theme.DarkSurface
import com.example.ui.theme.DarkSurfaceBorder
import com.example.ui.theme.DarkSurfaceElevated
import com.example.ui.theme.ErrorCoral
import com.example.ui.theme.MintAccent
import com.example.ui.theme.TextMuted
import com.example.ui.theme.TextPrimary
import com.example.ui.theme.TextSecondary
import com.example.ui.theme.WarningAmber

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ControllerViewerScreen(viewModel: MahiViewModel) {
    val session = viewModel.activeControllerSession.collectAsState().value ?: return
    val selectedViewerTab by viewModel.remoteViewerTab.collectAsState()
    val remoteMetrics by viewModel.remoteMetrics.collectAsState()
    val hasVideoFrames by viewModel.remoteVideoHasFrames.collectAsState()
    val remoteTelemetry by viewModel.remoteTelemetry.collectAsState()

    var keyboardInput by remember { mutableStateOf("") }
    val touchRipples = remember { mutableStateListOf<Offset>() }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = DarkCharcoalBg,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(MintAccent)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = session.targetDeviceName,
                                color = TextPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text(
                            text = if (hasVideoFrames) {
                                "${remoteMetrics.roundTripTimeMs} ms • ${remoteMetrics.currentFps} FPS • ${remoteMetrics.bitrateKbps / 1000f} Mbps"
                            } else {
                                "Waiting for real video frames"
                            },
                            color = CyanAccent,
                            fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                },
                navigationIcon = {
                    IconButton(
                        onClick = { viewModel.disconnectControllerSession() },
                        modifier = Modifier.testTag("controller_back_btn")
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = TextSecondary
                        )
                    }
                },
                actions = {
                    Button(
                        onClick = { viewModel.disconnectControllerSession() },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ErrorCoral.copy(alpha = 0.2f),
                            contentColor = ErrorCoral
                        ),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .padding(end = 8.dp)
                            .testTag("controller_disconnect_btn")
                    ) {
                        Text("Disconnect", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = DarkSurface
                )
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            // Secondary Navigation Tabs: Screen, Files, Apps, Diagnostics
            TabRow(
                selectedTabIndex = selectedViewerTab.ordinal,
                containerColor = DarkSurface,
                contentColor = CyanAccent,
                indicator = { tabPositions ->
                    TabRowDefaults.SecondaryIndicator(
                        Modifier.tabIndicatorOffset(tabPositions[selectedViewerTab.ordinal]),
                        color = CyanAccent
                    )
                }
            ) {
                RemoteViewerTab.values().forEach { tab ->
                    Tab(
                        selected = selectedViewerTab == tab,
                        onClick = { viewModel.setRemoteViewerTab(tab) },
                        text = {
                            Text(
                                text = tab.title,
                                fontSize = 12.sp,
                                fontWeight = if (selectedViewerTab == tab) FontWeight.Bold else FontWeight.Normal
                            )
                        },
                        modifier = Modifier.testTag("viewer_tab_${tab.name.lowercase()}")
                    )
                }
            }

            // Tab Content
            when (selectedViewerTab) {
                RemoteViewerTab.SCREEN -> {
                    RemoteScreenViewport(
                        viewModel = viewModel,
                        sessionResolution = session.screenResolution,
                        touchRipples = touchRipples,
                        keyboardInput = keyboardInput,
                        onKeyboardInputChanged = { keyboardInput = it },
                        onSendText = {
                            if (keyboardInput.isNotBlank()) {
                                viewModel.sendRemoteTextInput(keyboardInput)
                                keyboardInput = ""
                            }
                        }
                    )
                }
                RemoteViewerTab.FILES -> {
                    RemoteFilesPane(viewModel = viewModel)
                }
                RemoteViewerTab.APPS -> {
                    RemoteAppsPane(viewModel = viewModel)
                }
                RemoteViewerTab.DIAGNOSTICS -> {
                    RemoteDiagnosticsPane(viewModel = viewModel)
                }
            }
        }
    }
}

@Composable
private fun RemoteScreenViewport(
    viewModel: MahiViewModel,
    sessionResolution: String,
    touchRipples: MutableList<Offset>,
    keyboardInput: String,
    onKeyboardInputChanged: (String) -> Unit,
    onSendText: () -> Unit
) {
    val context = LocalContext.current
    val hasVideoFrames by viewModel.remoteVideoHasFrames.collectAsState()
    val videoRenderer = remember { SurfaceViewRenderer(context) }
    DisposableEffect(videoRenderer) {
        viewModel.attachRemoteVideoRenderer(videoRenderer)
        onDispose { viewModel.detachRemoteVideoRenderer(videoRenderer) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        // Live Screen Canvas Container with 9:16 aspect ratio
        BoxWithConstraints(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center
        ) {
            val canvasWidth = this.maxWidth
            val canvasHeight = this.maxHeight

            Box(
                modifier = Modifier
                    .aspectRatio(9f / 16f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(16.dp))
                    .background(Color.Black)
                    .border(2.dp, CyanAccent.copy(alpha = 0.4f), RoundedCornerShape(16.dp))
                    .testTag("remote_screen_canvas")
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onTap = { offset ->
                                touchRipples.add(offset)
                                if (touchRipples.size > 5) touchRipples.removeAt(0)
                                viewModel.sendRemoteTap(offset.x, offset.y, size.width.toFloat(), size.height.toFloat())
                            },
                            onDoubleTap = { offset ->
                                touchRipples.add(offset)
                                viewModel.sendRemoteDoubleTap(offset.x, offset.y, size.width.toFloat(), size.height.toFloat())
                            },
                            onLongPress = { offset ->
                                touchRipples.add(offset)
                                viewModel.sendRemoteLongPress(offset.x, offset.y, size.width.toFloat(), size.height.toFloat())
                            }
                        )
                    }
                    .pointerInput(Unit) {
                        var startX = 0f
                        var startY = 0f
                        var startMillis = 0L

                        detectDragGestures(
                            onDragStart = { offset ->
                                startX = offset.x
                                startY = offset.y
                                startMillis = System.currentTimeMillis()
                            },
                            onDragEnd = {
                                // Handled
                            },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                val currentX = change.position.x
                                val currentY = change.position.y
                                val duration = (System.currentTimeMillis() - startMillis).coerceIn(100L, 800L)
                                viewModel.sendRemoteSwipe(startX, startY, currentX, currentY, duration, size.width.toFloat(), size.height.toFloat())
                                startX = currentX
                                startY = currentY
                            }
                        )
                    }
            ) {
                AndroidView(
                    factory = { videoRenderer },
                    modifier = Modifier.fillMaxSize()
                )

                if (!hasVideoFrames) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Icon(
                            Icons.Default.ScreenShare,
                            contentDescription = null,
                            tint = CyanAccent.copy(alpha = 0.8f),
                            modifier = Modifier.size(44.dp)
                        )
                        Text(
                            text = "WAITING FOR REMOTE VIDEO",
                            color = CyanAccent,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.sp
                        )
                        Text(
                            text = "The receiver must approve screen sharing and start its Android media session. The real screen will appear here when the first video frame arrives.",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                }

                // Volume & Quick System Controls overlay in top-right of canvas
                Row(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    IconButton(
                        onClick = { viewModel.sendRemoteVolume("DOWN") },
                        modifier = Modifier
                            .size(32.dp)
                            .background(DarkSurface.copy(alpha = 0.8f), CircleShape)
                    ) {
                        Icon(Icons.Default.VolumeDown, contentDescription = "Vol Down", tint = TextPrimary, modifier = Modifier.size(16.dp))
                    }
                    IconButton(
                        onClick = { viewModel.sendRemoteVolume("UP") },
                        modifier = Modifier
                            .size(32.dp)
                            .background(DarkSurface.copy(alpha = 0.8f), CircleShape)
                    ) {
                        Icon(Icons.Default.VolumeUp, contentDescription = "Vol Up", tint = TextPrimary, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(6.dp))

        // Quick Keyboard Input Bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            OutlinedTextField(
                value = keyboardInput,
                onValueChange = onKeyboardInputChanged,
                placeholder = { Text("Type remote text...", color = TextMuted, fontSize = 12.sp) },
                singleLine = true,
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .testTag("remote_text_field"),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = CyanAccent,
                    unfocusedBorderColor = DarkSurfaceBorder,
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary,
                    focusedContainerColor = DarkSurfaceElevated,
                    unfocusedContainerColor = DarkSurfaceElevated
                ),
                shape = RoundedCornerShape(10.dp)
            )

            IconButton(
                onClick = onSendText,
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(CyanAccent)
                    .testTag("send_remote_text_btn")
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = DarkCharcoalBg)
            }
        }

        Spacer(modifier = Modifier.height(6.dp))

        // Android System Navigation Floating Bar
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DarkSurface),
            border = BorderStroke(1.dp, DarkSurfaceBorder),
            shape = RoundedCornerShape(14.dp)
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp, horizontal = 8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                NavActionItem(
                    icon = Icons.AutoMirrored.Filled.ArrowBack,
                    label = "Back",
                    onClick = { viewModel.sendRemoteGlobalAction("BACK") },
                    testTag = "nav_back_btn"
                )
                NavActionItem(
                    icon = Icons.Default.Home,
                    label = "Home",
                    onClick = { viewModel.sendRemoteGlobalAction("HOME") },
                    testTag = "nav_home_btn"
                )
                NavActionItem(
                    icon = Icons.Default.Tab,
                    label = "Recents",
                    onClick = { viewModel.sendRemoteGlobalAction("RECENTS") },
                    testTag = "nav_recents_btn"
                )
                NavActionItem(
                    icon = Icons.Default.Notifications,
                    label = "Shade",
                    onClick = { viewModel.sendRemoteGlobalAction("NOTIFICATIONS") },
                    testTag = "nav_notifications_btn"
                )
                NavActionItem(
                    icon = Icons.Default.Settings,
                    label = "Quick Set",
                    onClick = { viewModel.sendRemoteGlobalAction("QUICK_SETTINGS") },
                    testTag = "nav_quick_settings_btn"
                )
                NavActionItem(
                    icon = Icons.Default.Lock,
                    label = "Lock",
                    onClick = { viewModel.sendRemoteGlobalAction("LOCK_SCREEN") },
                    testTag = "nav_lock_btn"
                )
            }
        }
    }
}

@Composable
private fun NavActionItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    testTag: String
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .testTag(testTag)
    ) {
        Icon(icon, contentDescription = label, tint = CyanAccent, modifier = Modifier.size(20.dp))
        Text(text = label, color = TextSecondary, fontSize = 9.sp)
    }
}

@Composable
private fun RemoteFilesPane(viewModel: MahiViewModel) {
    val remoteFiles by viewModel.remoteFileList.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "REMOTE STORAGE (RECEIVER PHONE)",
                color = CyanAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold
            )

            IconButton(
                onClick = { viewModel.fetchRemoteFiles() },
                modifier = Modifier.size(32.dp)
            ) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = CyanAccent)
            }
        }

        if (remoteFiles.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Folder, contentDescription = null, tint = TextMuted, modifier = Modifier.size(48.dp))
                    Spacer(modifier = Modifier.height(10.dp))
                    Text("No files received or directory is empty.", color = TextMuted, fontSize = 13.sp)
                    Spacer(modifier = Modifier.height(10.dp))
                    Button(
                        onClick = { viewModel.fetchRemoteFiles() },
                        colors = ButtonDefaults.buttonColors(containerColor = CyanAccent, contentColor = DarkCharcoalBg)
                    ) {
                        Text("Query Receiver Storage")
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(remoteFiles) { file ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = BorderStroke(1.dp, DarkSurfaceBorder),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                if (file.isDirectory) Icons.Default.Folder else Icons.Default.Tab,
                                contentDescription = null,
                                tint = if (file.isDirectory) CyanAccent else MintAccent,
                                modifier = Modifier.size(24.dp)
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = file.name,
                                    color = TextPrimary,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = if (file.isDirectory) "Directory" else "${file.sizeBytes / 1024} KB",
                                    color = TextSecondary,
                                    fontSize = 11.sp
                                )
                            }
                            IconButton(
                                onClick = { viewModel.deleteRemoteFile(file.path) }
                            ) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = ErrorCoral.copy(alpha = 0.8f))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RemoteAppsPane(viewModel: MahiViewModel) {
    val remoteApps by viewModel.remoteAppList.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "REMOTE APPLICATIONS",
                color = CyanAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold
            )

            IconButton(
                onClick = { viewModel.fetchRemoteApps() },
                modifier = Modifier.size(32.dp)
            ) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = CyanAccent)
            }
        }

        if (remoteApps.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Apps, contentDescription = null, tint = TextMuted, modifier = Modifier.size(48.dp))
                    Spacer(modifier = Modifier.height(10.dp))
                    Text("Remote app catalog not loaded.", color = TextMuted, fontSize = 13.sp)
                    Spacer(modifier = Modifier.height(10.dp))
                    Button(
                        onClick = { viewModel.fetchRemoteApps() },
                        colors = ButtonDefaults.buttonColors(containerColor = CyanAccent, contentColor = DarkCharcoalBg)
                    ) {
                        Text("List Installed Apps")
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(remoteApps) { app ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = BorderStroke(1.dp, DarkSurfaceBorder),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = app.appName,
                                    color = TextPrimary,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = app.packageName,
                                    color = TextSecondary,
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                            IconButton(
                                onClick = { viewModel.launchRemoteApp(app.packageName) }
                            ) {
                                Icon(Icons.Default.PlayArrow, contentDescription = "Launch", tint = MintAccent)
                            }
                            IconButton(
                                onClick = { viewModel.openRemoteAppSettings(app.packageName) }
                            ) {
                                Icon(Icons.Default.Settings, contentDescription = "Settings", tint = CyanAccent)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RemoteDiagnosticsPane(viewModel: MahiViewModel) {
    val telemetry by viewModel.remoteTelemetry.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "REMOTE HARDWARE TELEMETRY",
                color = CyanAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold
            )

            Button(
                onClick = { viewModel.runRemoteDiagnostics() },
                colors = ButtonDefaults.buttonColors(containerColor = CyanAccent, contentColor = DarkCharcoalBg),
                shape = RoundedCornerShape(8.dp)
            ) {
                Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("Run Test Suite", fontSize = 12.sp)
            }
        }

        val battery = telemetry?.batteryPercent ?: 88
        val temp = telemetry?.batteryTempC ?: 34.0f
        val storage = telemetry?.storageFree ?: "38.2 GB"
        val rtt = telemetry?.roundTripTimeMs ?: 32

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = DarkSurface),
            border = BorderStroke(1.dp, DarkSurfaceBorder),
            shape = RoundedCornerShape(16.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                TelemetryMetricItem("Battery Health", "$battery% • ${if (battery > 20) "NORMAL" else "LOW"}")
                LinearProgressIndicator(
                    progress = { battery / 100f },
                    modifier = Modifier.fillMaxWidth().height(6.dp),
                    color = if (battery > 20) MintAccent else ErrorCoral,
                    trackColor = DarkSurfaceElevated
                )

                TelemetryMetricItem("Thermal Subsystem", "$temp °C • OPTIMAL")
                TelemetryMetricItem("Shared Storage Free", "$storage Available")
                TelemetryMetricItem("Network Round-Trip Latency", "$rtt ms • WebRTC DataChannel Active")
            }
        }
    }
}

@Composable
private fun TelemetryMetricItem(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = label, color = TextSecondary, fontSize = 12.sp)
        Text(text = value, color = TextPrimary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}
