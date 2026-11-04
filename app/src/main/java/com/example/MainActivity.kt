package com.example

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.CastConnected
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.QrCode
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.remotescreen.ScreenCaptureService
import com.example.remotescreen.ScreenStreamState
import com.example.ui.MainTab
import com.example.ui.MahiViewModel
import com.example.ui.components.OperatorApprovalDialog
import com.example.ui.screens.AppManagerScreen
import com.example.ui.screens.AuditLogScreen
import com.example.ui.screens.DashboardScreen
import com.example.ui.screens.DiagnosticsScreen
import com.example.ui.screens.FileManagerScreen
import com.example.ui.screens.PairingScreen
import com.example.ui.screens.RemoteServicesScreen
import com.example.ui.theme.CyanAccent
import com.example.ui.theme.DarkCharcoalBg
import com.example.ui.theme.DarkSurface
import com.example.ui.theme.DarkSurfaceBorder
import com.example.ui.theme.DarkSurfaceElevated
import com.example.ui.theme.ErrorCoral
import com.example.ui.theme.MahiRemoteTheme
import com.example.ui.theme.MintAccent
import com.example.ui.theme.TextMuted
import com.example.ui.theme.TextPrimary
import com.example.ui.theme.TextSecondary
import com.example.ui.theme.WarningAmber

class MainActivity : ComponentActivity() {

    private val viewModel: MahiViewModel by viewModels()

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_START
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
                putExtra(ScreenCaptureService.EXTRA_PRESET, viewModel.videoPreset.value.name)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } else {
            Toast.makeText(this, "Screen share permission was declined", Toast.LENGTH_SHORT).show()
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Notification permission handled
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            MahiRemoteTheme {
                MainAppScaffold(
                    viewModel = viewModel,
                    onRequestScreenShare = { requestScreenShareConsent() }
                )
            }
        }
    }

    private fun requestScreenShareConsent() {
        if (ScreenCaptureService.isStreaming()) {
            ScreenCaptureService.stop(this)
            Toast.makeText(this, "Screen streaming stopped", Toast.LENGTH_SHORT).show()
            return
        }

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val intent = projectionManager.createScreenCaptureIntent()
        screenCaptureLauncher.launch(intent)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainAppScaffold(
    viewModel: MahiViewModel,
    onRequestScreenShare: () -> Unit
) {
    val appRole by viewModel.appRole.collectAsState()
    val activeControllerSession by viewModel.activeControllerSession.collectAsState()
    val selectedTab by viewModel.selectedTab.collectAsState()
    val pendingRequest by viewModel.pairingManager.pendingRequest.collectAsState()
    val activeSession by viewModel.pairingManager.activeSession.collectAsState()
    val showDisconnectDialog by viewModel.showDisconnectDialog.collectAsState()
    val streamState by viewModel.screenStreamState.collectAsState()
    val signalingStatus by viewModel.signalingClient.connectionStatus.collectAsState()
    val serverUrl by viewModel.signalingClient.serverUrl.collectAsState()

    var showHome by remember { mutableStateOf(true) }
    var showMore by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

    if (!showHome && appRole == com.example.controller.AppRole.CONTROLLER && activeControllerSession != null) {
        com.example.ui.screens.ControllerViewerScreen(viewModel = viewModel)
        return
    }

    val statusColor = when {
        activeSession != null || activeControllerSession != null -> MintAccent
        streamState is ScreenStreamState.Active -> CyanAccent
        signalingStatus == com.example.signaling.ConnectionStatus.AUTHENTICATED ||
            signalingStatus == com.example.signaling.ConnectionStatus.CONNECTED -> CyanAccent
        else -> WarningAmber
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = DarkCharcoalBg,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    if (!showHome) {
                        TextButton(
                            onClick = {
                                showHome = true
                                showMore = false
                                viewModel.setAppRole(com.example.controller.AppRole.RECEIVER)
                            }
                        ) { Text("Back", color = TextSecondary) }
                    }
                },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(statusColor)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Mahi Remote",
                            color = TextPrimary,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Security, contentDescription = "Connection settings", tint = TextSecondary)
                    }
                    if (!showHome && appRole == com.example.controller.AppRole.RECEIVER) {
                        Box {
                            IconButton(onClick = { showMore = true }) {
                                Icon(Icons.Default.Dashboard, contentDescription = "More tools", tint = TextSecondary)
                            }
                            DropdownMenu(expanded = showMore, onDismissRequest = { showMore = false }) {
                                val menuItems = listOf(
                                    MainTab.DASHBOARD,
                                    MainTab.PAIRING,
                                    MainTab.SERVICES,
                                    MainTab.DIAGNOSTICS,
                                    MainTab.FILES,
                                    MainTab.APPS,
                                    MainTab.AUDIT
                                )
                                menuItems.forEach { tab ->
                                    DropdownMenuItem(
                                        text = { Text(tab.title) },
                                        onClick = {
                                            showMore = false
                                            viewModel.selectTab(tab)
                                        }
                                    )
                                }
                            }
                        }
                        IconButton(
                            onClick = { viewModel.setShowDisconnectDialog(true) },
                            modifier = Modifier.testTag("appbar_emergency_btn")
                        ) {
                            Icon(
                                Icons.Default.Warning,
                                contentDescription = "Emergency Stop",
                                tint = if (activeSession != null) ErrorCoral else TextMuted
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = DarkSurface)
            )
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            if (showHome) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 22.dp, vertical = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp)
                ) {
                    Text(
                        "Control your devices remotely",
                        color = TextPrimary,
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        "Connect over the internet. Both devices do not need to use the same Wi-Fi network.",
                        color = TextSecondary,
                        fontSize = 14.sp,
                        lineHeight = 20.sp
                    )
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 116.dp)
                            .clickable {
                                viewModel.setAppRole(com.example.controller.AppRole.CONTROLLER)
                                showHome = false
                            },
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkSurfaceBorder),
                        shape = RoundedCornerShape(18.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(20.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Default.PhoneAndroid, contentDescription = null, tint = CyanAccent, modifier = Modifier.size(30.dp))
                            Spacer(modifier = Modifier.width(16.dp))
                            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                Text("Control another device", color = TextPrimary, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                                Text("Connect to another Android phone using a six-digit code or QR.", color = TextSecondary, fontSize = 13.sp)
                            }
                        }
                    }
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 116.dp)
                            .clickable {
                                viewModel.setAppRole(com.example.controller.AppRole.RECEIVER)
                                viewModel.selectTab(MainTab.PAIRING)
                                showHome = false
                            },
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkSurfaceBorder),
                        shape = RoundedCornerShape(18.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(20.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Default.CastConnected, contentDescription = null, tint = MintAccent, modifier = Modifier.size(30.dp))
                            Spacer(modifier = Modifier.width(16.dp))
                            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                Text("Share this phone", color = TextPrimary, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                                Text("Let another phone or a browser request permission to control this device.", color = TextSecondary, fontSize = 13.sp)
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(statusColor))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = when (signalingStatus) {
                                com.example.signaling.ConnectionStatus.AUTHENTICATED -> "Approved remote session authenticated"
                                com.example.signaling.ConnectionStatus.CONNECTED -> "Connected to signaling server"
                                com.example.signaling.ConnectionStatus.CONNECTING -> "Connecting to remote service…"
                                com.example.signaling.ConnectionStatus.ERROR -> "Remote service configuration or connection error"
                                else -> "Remote service not connected"
                            },
                            color = TextMuted,
                            fontSize = 12.sp
                        )
                    }
                }
            } else if (appRole == com.example.controller.AppRole.CONTROLLER) {
                com.example.ui.screens.ControllerDashboardScreen(viewModel = viewModel)
            } else {
                when (selectedTab) {
                    MainTab.DASHBOARD -> DashboardScreen(viewModel, onRequestScreenShare)
                    MainTab.PAIRING -> PairingScreen(viewModel)
                    MainTab.SERVICES -> RemoteServicesScreen(viewModel, onRequestScreenShare)
                    MainTab.DIAGNOSTICS -> DiagnosticsScreen(viewModel)
                    MainTab.FILES -> FileManagerScreen(viewModel)
                    MainTab.APPS -> AppManagerScreen(viewModel)
                    MainTab.AUDIT -> AuditLogScreen(viewModel)
                }
            }
        }
    }

    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            containerColor = DarkSurface,
            title = { Text("Connection settings", color = TextPrimary) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Signaling status: ${signalingStatus.name}", color = TextSecondary)
                    Text("Signaling URL: ${serverUrl.ifBlank { "Not configured" }}", color = TextSecondary)
                    Text("Public URL and ICE settings are loaded from the backend runtime configuration.", color = TextMuted, fontSize = 12.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = { showSettings = false }) {
                    Text("Done", color = CyanAccent)
                }
            }
        )
    }

    if (pendingRequest != null) {
        OperatorApprovalDialog(
            request = pendingRequest!!,
            onApprove = { viewModel.approveIncomingRequest(pendingRequest!!) },
            onReject = { viewModel.rejectIncomingRequest(pendingRequest!!) }
        )
    }

    if (showDisconnectDialog) {
        AlertDialog(
            onDismissRequest = { viewModel.setShowDisconnectDialog(false) },
            containerColor = DarkSurface,
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Warning, contentDescription = null, tint = ErrorCoral)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Emergency Stop", color = TextPrimary, fontWeight = FontWeight.Bold)
                }
            },
            text = {
                Text(
                    text = "Stop the current remote session and revoke its server-side authorization immediately.",
                    color = TextSecondary,
                    fontSize = 13.sp
                )
            },
            confirmButton = {
                Button(
                    onClick = { viewModel.emergencyDisconnect() },
                    colors = ButtonDefaults.buttonColors(containerColor = ErrorCoral, contentColor = DarkCharcoalBg),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.testTag("confirm_emergency_killswitch")
                ) {
                    Text("Stop session", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.setShowDisconnectDialog(false) }) {
                    Text("Cancel", color = TextSecondary)
                }
            }
        )
    }
}
