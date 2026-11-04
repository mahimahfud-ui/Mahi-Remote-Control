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
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import com.example.ui.screens.HomeScreen
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
            viewModel.setScreenCaptureConsent(result.resultCode, result.data!!)
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

    var showMoreMenu by remember { mutableStateOf(false) }

    // If Controller has an active session, display the full-screen remote viewer
    if (appRole == com.example.controller.AppRole.CONTROLLER && activeControllerSession != null) {
        com.example.ui.screens.ControllerViewerScreen(viewModel = viewModel)
        return
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = DarkCharcoalBg,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(
                                    when {
                                        activeSession != null -> MintAccent
                                        activeControllerSession != null -> MintAccent
                                        streamState is ScreenStreamState.Active -> CyanAccent
                                        else -> WarningAmber
                                    }
                                )
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Mahi Remote",
                            color = TextPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.5.sp
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showMoreMenu = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More", tint = TextPrimary)
                    }
                    DropdownMenu(expanded = showMoreMenu, onDismissRequest = { showMoreMenu = false }) {
                        DropdownMenuItem(text = { Text("Home") }, onClick = {
                            showMoreMenu = false
                            viewModel.setAppRole(com.example.controller.AppRole.RECEIVER)
                            viewModel.selectTab(MainTab.DASHBOARD)
                        })
                        DropdownMenuItem(text = { Text("Control another device") }, onClick = {
                            showMoreMenu = false
                            viewModel.setAppRole(com.example.controller.AppRole.CONTROLLER)
                        })
                        DropdownMenuItem(text = { Text("Share this phone") }, onClick = {
                            showMoreMenu = false
                            viewModel.setAppRole(com.example.controller.AppRole.RECEIVER)
                            viewModel.selectTab(MainTab.PAIRING)
                        })
                        DropdownMenuItem(text = { Text("Files") }, onClick = { showMoreMenu = false; viewModel.selectTab(MainTab.FILES) })
                        DropdownMenuItem(text = { Text("Apps") }, onClick = { showMoreMenu = false; viewModel.selectTab(MainTab.APPS) })
                        DropdownMenuItem(text = { Text("Diagnostics") }, onClick = { showMoreMenu = false; viewModel.selectTab(MainTab.DIAGNOSTICS) })
                        DropdownMenuItem(text = { Text("Services") }, onClick = { showMoreMenu = false; viewModel.selectTab(MainTab.SERVICES) })
                        DropdownMenuItem(text = { Text("Security log") }, onClick = { showMoreMenu = false; viewModel.selectTab(MainTab.AUDIT) })
                    }
                    if (activeSession != null || activeControllerSession != null) {
                        IconButton(onClick = { viewModel.setShowDisconnectDialog(true) }, modifier = Modifier.testTag("appbar_emergency_btn")) {
                            Icon(Icons.Default.Warning, contentDescription = "Emergency Stop", tint = ErrorCoral)
                        }
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = DarkSurface
                )
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            if (appRole == com.example.controller.AppRole.CONTROLLER) {
                com.example.ui.screens.ControllerDashboardScreen(viewModel = viewModel)
            } else {
                when (selectedTab) {
                    MainTab.DASHBOARD -> HomeScreen(
                        onControlAnotherDevice = { viewModel.setAppRole(com.example.controller.AppRole.CONTROLLER) },
                        onShareThisPhone = {
                            viewModel.setAppRole(com.example.controller.AppRole.RECEIVER)
                            viewModel.selectTab(MainTab.PAIRING)
                        }
                    )
                    MainTab.PAIRING -> PairingScreen(viewModel, onRequestScreenShare)
                    MainTab.SERVICES -> RemoteServicesScreen(viewModel, onRequestScreenShare)
                    MainTab.DIAGNOSTICS -> DiagnosticsScreen(viewModel)
                    MainTab.FILES -> FileManagerScreen(viewModel)
                    MainTab.APPS -> AppManagerScreen(viewModel)
                    MainTab.AUDIT -> AuditLogScreen(viewModel)
                }
            }
        }
    }

    // Modal: Operator Approval Request
    if (pendingRequest != null) {
        OperatorApprovalDialog(
            request = pendingRequest!!,
            onApprove = { viewModel.approveIncomingRequest(pendingRequest!!) },
            onReject = { viewModel.rejectIncomingRequest(pendingRequest!!) }
        )
    }

    // Modal: Emergency Disconnect Confirmation
    if (showDisconnectDialog) {
        AlertDialog(
            onDismissRequest = { viewModel.setShowDisconnectDialog(false) },
            containerColor = DarkSurface,
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Warning, contentDescription = null, tint = ErrorCoral)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Emergency Killswitch", color = TextPrimary, fontWeight = FontWeight.Bold)
                }
            },
            text = {
                Text(
                    text = "This will immediately terminate all active remote screen streams, disconnect the Windows operator in Sylhet, and revoke current session tokens.",
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
                    Text("Sever Connection Now", fontWeight = FontWeight.Bold)
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
