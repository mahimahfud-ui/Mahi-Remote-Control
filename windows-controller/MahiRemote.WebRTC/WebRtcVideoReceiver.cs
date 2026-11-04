using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace MahiRemote.WebRTC;

public class VideoStreamStatistics
{
    public int Fps { get; set; }
    public int BitrateKbps { get; set; }
    public string Resolution { get; set; } = "Waiting for stream";
    public int Width { get; set; } = 1080;
    public int Height { get; set; } = 1920;
    public int RoundTripTimeMs { get; set; }
    public float PacketLossPercent { get; set; }
    public long TotalFramesRendered { get; set; } = 0;
    public long TotalFramesDropped { get; set; } = 0;
    public string IceConnectionType { get; set; } = "Not connected";
}

public class IceServerConfig
{
    // STUN is public. TURN must be appended only after fetching short-lived,
    // session-authorized credentials from the backend /api/v1/turn/credentials.
    public string[] Urls { get; set; } = new[]
    {
        "stun:stun.l.google.com:19302"
    };
    public string Username { get; set; } = string.Empty;
    public string Credential { get; set; } = string.Empty;

    public bool HasTurnCredentials =>
        !string.IsNullOrWhiteSpace(Username) &&
        !string.IsNullOrWhiteSpace(Credential) &&
        Urls.Any(url => url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) ||
                        url.StartsWith("turns:", StringComparison.OrdinalIgnoreCase));
}

public class WebRtcVideoReceiver
{
    public event Action<WriteableBitmap>? OnFrameBitmapReady;
    public event Action<VideoStreamStatistics>? OnStatsUpdated;
    public event Action<string>? OnStatusChanged;

    public VideoStreamStatistics CurrentStats { get; } = new();
    public IceServerConfig IceConfig { get; } = new();

    private WriteableBitmap? _screenBitmap;
    private bool _isRunning = false;
    private readonly object _renderLock = new();

    public WriteableBitmap? GetCurrentBitmap() => _screenBitmap;
    public bool HasLiveVideo => CurrentStats.TotalFramesRendered > 0;

    public void InitializeSurface(int width = 1080, int height = 1920)
    {
        lock (_renderLock)
        {
            CurrentStats.Width = width;
            CurrentStats.Height = height;
            CurrentStats.Resolution = "Waiting for a decoded receiver frame";
            _screenBitmap = null;
        }
    }

    public void StartReceiving(string sdpAnswer)
    {
        // This project currently has no native Windows WebRTC peer connection/decoder.
        // Do not mark a session live or render fabricated frames from an SDP string.
        _isRunning = false;
        OnStatusChanged?.Invoke(
            "Live video is unavailable: the native Windows WebRTC media pipeline has not been implemented."
        );
    }

    public void ProcessDecodedVideoBuffer(byte[] rawBgraBytes, int width, int height)
    {
        if (!_isRunning || rawBgraBytes == null || rawBgraBytes.Length == 0) return;

        Application.Current?.Dispatcher.Invoke(() =>
        {
            lock (_renderLock)
            {
                if (_screenBitmap == null || _screenBitmap.PixelWidth != width || _screenBitmap.PixelHeight != height)
                {
                    _screenBitmap = new WriteableBitmap(width, height, 96, 96, PixelFormats.Bgra32, null);
                }

                _screenBitmap.Lock();
                try
                {
                    unsafe
                    {
                        IntPtr pBackBuffer = _screenBitmap.BackBuffer;
                        System.Runtime.InteropServices.Marshal.Copy(rawBgraBytes, 0, pBackBuffer, rawBgraBytes.Length);
                    }
                    _screenBitmap.AddDirtyRect(new Int32Rect(0, 0, width, height));
                }
                finally
                {
                    _screenBitmap.Unlock();
                }

                CurrentStats.TotalFramesRendered++;
                OnFrameBitmapReady?.Invoke(_screenBitmap);
            }
        });
    }

    public void UpdateMetrics(int fps, int bitrateKbps, int rttMs, float packetLoss = 0.005f)
    {
        CurrentStats.Fps = fps;
        CurrentStats.BitrateKbps = bitrateKbps;
        CurrentStats.RoundTripTimeMs = rttMs;
        CurrentStats.PacketLossPercent = packetLoss;
        OnStatsUpdated?.Invoke(CurrentStats);
    }

    public void Stop()
    {
        _isRunning = false;
    }
}
