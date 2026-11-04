using System.Collections.ObjectModel;
using MahiRemote.Core.Models;

namespace MahiRemote.Devices;

public class DeviceManager
{
    // The list starts empty and is populated only by server-confirmed pairings.
    public ObservableCollection<DeviceInfo> PairedDevices { get; } = new();

    public void AddDevice(DeviceInfo device)
    {
        var existing = PairedDevices.FirstOrDefault(d => d.DeviceId == device.DeviceId);
        if (existing != null)
        {
            PairedDevices.Remove(existing);
        }
        PairedDevices.Insert(0, device);
    }

    public void RemoveDevice(string deviceId)
    {
        var target = PairedDevices.FirstOrDefault(d => d.DeviceId == deviceId);
        if (target != null)
        {
            PairedDevices.Remove(target);
        }
    }
}
