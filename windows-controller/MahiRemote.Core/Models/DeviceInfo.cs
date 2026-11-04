namespace MahiRemote.Core.Models;

public record DeviceInfo
{
    public required string DeviceId { get; init; }
    public required string DeviceName { get; init; }
    public required string Fingerprint { get; init; }
    public string AndroidVersion { get; init; } = "Not reported";
    public int? BatteryPercent { get; init; }
    public bool? IsCharging { get; init; }
    public string NetworkType { get; init; } = "Not reported";
    public string? IpAddress { get; init; }
    public bool IsOnline { get; init; } = true;
    public DateTime? LastSeen { get; init; } = DateTime.UtcNow;
}

public record DeviceSession
{
    public required string SessionId { get; init; }
    public required string DeviceId { get; init; }
    public required string OperatorName { get; init; }
    public required string OperatorLocation { get; init; }
    public DateTime StartedAt { get; init; } = DateTime.UtcNow;
    public bool IsActive { get; init; } = true;
}
