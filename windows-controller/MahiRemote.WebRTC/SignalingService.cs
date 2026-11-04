using System.Net.WebSockets;
using System.Text;
using System.IO;
using System.Text.Json;
using MahiRemote.Core.Models;
using MahiRemote.Security;

namespace MahiRemote.WebRTC;

public class SignalingService
{
    private ClientWebSocket? _ws;
    private readonly CryptoProvider _crypto;
    private CancellationTokenSource? _cts;
    private long _commandSequence = 1;
    private string? _lastServerUrl;
    private string? _lastOperatorName;
    private string? _lastLocation;
    private string? _sessionToken;

    public event Action<string>? OnStatusChanged;
    public event Action<string, string>? OnSdpReceived;
    public event Action<string>? OnIceCandidateReceived;
    public event Action<long, bool, int>? OnCommandAckReceived;
    public event Action<string>? OnRemoteAppListReceived;
    public event Action<string>? OnRemoteFileListReceived;
    public event Action<string, long, string>? OnRemoteFileChunkReceived;
    public event Action<string>? OnDiagnosticsReportReceived;
    public event Action<int, int, string>? OnResolutionSyncReceived;
    public event Action<DeviceInfo>? OnPairedDevice;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public SignalingService(CryptoProvider crypto)
    {
        _crypto = crypto;
    }

    public async Task ConnectAsync(string serverUrl, string operatorName, string location)
    {
        _lastServerUrl = serverUrl;
        _lastOperatorName = operatorName;
        _lastLocation = location;

        _cts?.Cancel();
        _cts = new CancellationTokenSource();

        _ws = new ClientWebSocket();
        _ws.Options.SetRequestHeader("X-Operator-Fingerprint", _crypto.OperatorFingerprint);
        _ws.Options.SetRequestHeader("X-Operator-Name", operatorName);
        _ws.Options.SetRequestHeader("X-Operator-Location", location);
        _ws.Options.SetRequestHeader("X-Device-Name", operatorName);

        OnStatusChanged?.Invoke($"Connecting to signaling server at {serverUrl}...");

        try
        {
            await _ws.ConnectAsync(new Uri(serverUrl), _cts.Token);
            OnStatusChanged?.Invoke("Connected & Authenticated with Signaling Server");

            _ = ReceiveLoopAsync(_cts.Token);
            _ = HeartbeatLoopAsync(_cts.Token);
            if (!string.IsNullOrWhiteSpace(_sessionToken))
            {
                await SendJsonAsync(new { type = "AUTHENTICATE", sessionToken = _sessionToken });
            }
        }
        catch (Exception ex)
        {
            OnStatusChanged?.Invoke($"Signaling connection failed: {ex.Message}. Scheduling auto-reconnect...");
            ScheduleReconnect();
        }
    }

    public async Task SendPairRequestAsync(string targetDeviceId, string pairingCode, string[] scopes)
    {
        var payload = new
        {
            type = "PAIR_REQUEST",
            targetDeviceId,
            code = pairingCode,
            pairingCode,
            fingerprint = _crypto.OperatorFingerprint,
            operatorFingerprint = _crypto.OperatorFingerprint,
            controllerName = _lastOperatorName ?? "Windows controller",
            operatorName = _lastOperatorName ?? "Windows controller",
            requestedScopes = scopes,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        await SendJsonAsync(payload);
    }

    public async Task<long> SendCommandAsync(CommandPacket command)
    {
        long seq = Interlocked.Increment(ref _commandSequence);

        var message = new
        {
            type = "INPUT_EVENT",
            sequence = seq,
            command
        };

        await SendJsonAsync(message);
        return seq;
    }

    public async Task SendAppCommandAsync(string action, string packageName = "")
    {
        var message = new
        {
            type = "APP_COMMAND",
            action,
            packageName
        };
        await SendJsonAsync(message);
    }

    public async Task SendFileCommandAsync(string action, string path, string name = "", long offset = 0, int length = 32768, string data = "")
    {
        var message = new
        {
            type = "FILE_COMMAND",
            action,
            path,
            name,
            offset,
            length,
            data
        };
        await SendJsonAsync(message);
    }

    public async Task SendDiagnosticsRunAsync()
    {
        var message = new
        {
            type = "DIAGNOSTICS_RUN"
        };
        await SendJsonAsync(message);
    }

    private async Task SendJsonAsync(object data)
    {
        if (_ws == null || _ws.State != WebSocketState.Open) return;
        string json = JsonSerializer.Serialize(data);
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[65536];
        while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
        {
            try
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                        OnStatusChanged?.Invoke("Disconnected from signaling server");
                        ScheduleReconnect();
                        return;
                    }

                    if (message.Length + result.Count > 1024 * 1024)
                    {
                        await _ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message exceeds 1 MiB limit", CancellationToken.None);
                        OnStatusChanged?.Invoke("Signaling message exceeded the 1 MiB safety limit.");
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    ProcessMessage(Encoding.UTF8.GetString(message.ToArray()));
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                OnStatusChanged?.Invoke($"Signaling socket interrupted: {ex.Message}");
                ScheduleReconnect();
                break;
            }
        }
    }

    private static JsonElement GetPayload(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("payload", out var payload))
            return root;

        if (payload.ValueKind == JsonValueKind.Object || payload.ValueKind == JsonValueKind.Array)
            return payload;

        // Android transports some JSON envelopes as a string-valued payload.
        // Clone the parsed element so it remains valid after the temporary document is disposed.
        if (payload.ValueKind == JsonValueKind.String)
        {
            var raw = payload.GetString();
            if (!string.IsNullOrWhiteSpace(raw))
            {
                try
                {
                    using var document = JsonDocument.Parse(raw);
                    return document.RootElement.Clone();
                }
                catch (JsonException)
                {
                    return payload;
                }
            }
        }

        return payload;
    }

    private static JsonElement FindValue(JsonElement root, JsonElement payload, string name)
    {
        if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var nested))
            return nested;
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var topLevel))
            return topLevel;
        return default;
    }

    private static string JsonText(JsonElement value, string fallback)
    {
        if (value.ValueKind == JsonValueKind.Undefined || value.ValueKind == JsonValueKind.Null)
            return fallback;
        return value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : value.GetRawText();
    }

    private static long Int64Value(JsonElement value, long fallback = 0)
    {
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? number
            : fallback;
    }

    private static bool BoolValue(JsonElement value, bool fallback = false)
    {
        return value.ValueKind == JsonValueKind.True ||
               (value.ValueKind != JsonValueKind.False && fallback);
    }

    private void ProcessMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("type", out var typeElem)) return;

            string type = typeElem.GetString() ?? "";
            var payload = GetPayload(root);

            switch (type)
            {
                case "SDP_ANSWER":
                    var sdp = JsonText(FindValue(root, payload, "sdp"), "");
                    if (!string.IsNullOrWhiteSpace(sdp))
                        OnSdpReceived?.Invoke("answer", sdp);
                    break;

                case "ICE_CANDIDATE":
                    var candidate = JsonText(FindValue(root, payload, "candidate"), "");
                    if (!string.IsNullOrWhiteSpace(candidate))
                        OnIceCandidateReceived?.Invoke(candidate);
                    break;

                case "COMMAND_ACK":
                    long seq = Int64Value(FindValue(root, payload, "sequence"));
                    bool ok = BoolValue(FindValue(root, payload, "success"));
                    int rtt = (int)Int64Value(FindValue(root, payload, "rtt"), 25);
                    OnCommandAckReceived?.Invoke(seq, ok, rtt);
                    break;

                case "APP_LIST_RESPONSE":
                    var apps = FindValue(root, payload, "apps");
                    OnRemoteAppListReceived?.Invoke(JsonText(apps, JsonText(payload, "[]")));
                    break;

                case "FILE_LIST_RESPONSE":
                    var files = FindValue(root, payload, "files");
                    OnRemoteFileListReceived?.Invoke(JsonText(files, JsonText(payload, "[]")));
                    break;

                case "FILE_CHUNK_RESPONSE":
                    string path = JsonText(FindValue(root, payload, "path"), "");
                    long offset = Int64Value(FindValue(root, payload, "offset"));
                    string data = JsonText(FindValue(root, payload, "data"), "");
                    OnRemoteFileChunkReceived?.Invoke(path, offset, data);
                    break;

                case "DIAGNOSTICS_RESULT":
                    OnDiagnosticsReportReceived?.Invoke(JsonText(payload, "{}"));
                    break;

                case "PAIR_PENDING":
                    OnStatusChanged?.Invoke("Pairing request sent. Waiting for the phone owner to approve.");
                    break;

                case "PAIR_ACCEPT":
                    string receiverId = JsonText(
                        FindValue(root, payload, "receiverId"),
                        JsonText(FindValue(root, payload, "sender"), "")
                    );
                    string receiverName = JsonText(FindValue(root, payload, "receiverName"), "Android receiver");
                    string receiverFingerprint = JsonText(FindValue(root, payload, "fingerprint"), "");
                    if (!string.IsNullOrWhiteSpace(receiverId) && !string.IsNullOrWhiteSpace(receiverFingerprint))
                    {
                        OnPairedDevice?.Invoke(new DeviceInfo
                        {
                            DeviceId = receiverId,
                            DeviceName = receiverName,
                            Fingerprint = receiverFingerprint,
                        });
                    }
                    OnStatusChanged?.Invoke("Phone owner approved pairing. Establishing the secure session.");
                    break;

                case "PAIR_REJECT":
                case "PAIR_ERROR":
                    string pairingError = JsonText(
                        FindValue(root, payload, "reason"),
                        JsonText(FindValue(root, payload, "error"), "Pairing request was rejected.")
                    );
                    OnStatusChanged?.Invoke("Pairing failed: " + pairingError);
                    break;

                case "SESSION_AUTHORIZED":
                    _sessionToken = JsonText(FindValue(root, payload, "sessionToken"), "");
                    if (!string.IsNullOrWhiteSpace(_sessionToken))
                        OnStatusChanged?.Invoke("Receiver approved the session. Secure session token received.");
                    break;

                case "AUTHENTICATED":
                    OnStatusChanged?.Invoke("Secure remote session reconnected.");
                    break;

                case "SESSION_REVOKED":
                case "DISCONNECTED":
                case "AUTHENTICATION_FAILED":
                    _sessionToken = null;
                    OnStatusChanged?.Invoke("Remote session ended or was revoked.");
                    break;

                case "SCOPE_REQUIRED":
                    string requiredScope = JsonText(FindValue(root, payload, "requiredScope"), "unknown");
                    OnStatusChanged?.Invoke($"The receiver did not approve the requested permission: {requiredScope}.");
                    break;

                case "RESOLUTION_SYNC":
                    int w = (int)Int64Value(FindValue(root, payload, "width"), 1080);
                    int h = (int)Int64Value(FindValue(root, payload, "height"), 1920);
                    string orient = JsonText(FindValue(root, payload, "orientation"), "PORTRAIT");
                    OnResolutionSyncReceived?.Invoke(w, h, orient);
                    break;
            }
        }
        catch (JsonException ex)
        {
            OnStatusChanged?.Invoke($"Ignored invalid signaling JSON: {ex.Message}");
        }
        catch (InvalidOperationException ex)
        {
            OnStatusChanged?.Invoke($"Ignored malformed signaling payload: {ex.Message}");
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
        {
            try
            {
                await Task.Delay(15000, ct);
                if (_ws?.State == WebSocketState.Open)
                {
                    await SendJsonAsync(new { type = "PING", timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                }
            }
            catch { break; }
        }
    }

    private void ScheduleReconnect()
    {
        Task.Run(async () =>
        {
            await Task.Delay(5000);
            if (!IsConnected && !string.IsNullOrEmpty(_lastServerUrl) && !string.IsNullOrEmpty(_lastOperatorName))
            {
                OnStatusChanged?.Invoke("Attempting automatic reconnection to signaling hub...");
                await ConnectAsync(_lastServerUrl, _lastOperatorName, _lastLocation ?? "Sylhet");
            }
        });
    }

    public async Task EmergencyDisconnectAsync(string reason)
    {
        try
        {
            await SendJsonAsync(new
            {
                type = "EMERGENCY_DISCONNECT",
                payload = new { reason }
            });
            // Allow the signaling server to revoke the peer session before closing the socket.
            await Task.Delay(150);
        }
        finally
        {
            await DisconnectAsync();
        }
    }

    public async Task DisconnectAsync()
    {
        _cts?.Cancel();
        _sessionToken = null;
        if (_ws != null && _ws.State == WebSocketState.Open)
        {
            await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Operator disconnected", CancellationToken.None);
        }
        _ws?.Dispose();
        _ws = null;
        OnStatusChanged?.Invoke("Signaling session terminated.");
    }
}
