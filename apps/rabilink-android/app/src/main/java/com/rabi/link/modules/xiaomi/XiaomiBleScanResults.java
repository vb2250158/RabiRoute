package com.rabi.link.modules.xiaomi;

import android.bluetooth.BluetoothDevice;
import android.bluetooth.le.ScanResult;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class XiaomiBleScanResults {
    private final Map<String, ScanResult> results = new HashMap<>();

    void clear() {
        results.clear();
    }

    void add(ScanResult result) {
        BluetoothDevice device = result.getDevice();
        String address = XiaomiBleFormatter.safeAddress(device);
        if (address != null) {
            results.put(address, result);
        }
    }

    ScanResult get(String address) {
        return results.get(address);
    }

    List<XiaomiBleProbeController.DeviceEntry> deviceEntries() {
        List<ScanResult> sorted = new ArrayList<>(results.values());
        sorted.sort((a, b) -> Integer.compare(b.getRssi(), a.getRssi()));

        List<XiaomiBleProbeController.DeviceEntry> entries = new ArrayList<>();
        for (ScanResult result : sorted) {
            BluetoothDevice device = result.getDevice();
            String address = XiaomiBleFormatter.safeAddress(device);
            if (address == null) {
                continue;
            }
            entries.add(new XiaomiBleProbeController.DeviceEntry(
                address,
                XiaomiBleFormatter.safeName(device),
                result.getRssi(),
                XiaomiBleFormatter.signalLabel(result)
            ));
        }
        return entries;
    }
}
