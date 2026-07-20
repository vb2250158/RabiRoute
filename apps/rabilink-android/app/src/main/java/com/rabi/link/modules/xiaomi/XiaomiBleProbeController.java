package com.rabi.link.modules.xiaomi;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Handler;

import java.util.List;

public final class XiaomiBleProbeController {
    public interface Listener {
        void onLog(String message);

        void onDevicesChanged(List<DeviceEntry> devices);

        void onScanningChanged(boolean scanning);
    }

    private final Context context;
    private final Handler handler;
    private final Listener listener;
    private final XiaomiBleScanResults scanResults = new XiaomiBleScanResults();
    private final XiaomiBleGattProbe gattProbe;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            scanResults.add(result);
            publishDevices();
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult result : results) {
                scanResults.add(result);
            }
            publishDevices();
        }

        @Override
        public void onScanFailed(int errorCode) {
            log("扫描失败：" + errorCode);
            setScanning(false);
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt bluetoothGatt, int status, int newState) {
            log("GATT 状态变化：status=" + status + "，state=" + newState);
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                log("已连接，正在发现 GATT 服务...");
                bluetoothGatt.discoverServices();
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                log("已断开连接。");
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt bluetoothGatt, int status) {
            gattProbe.onServicesDiscovered(bluetoothGatt, status);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt bluetoothGatt, BluetoothGattCharacteristic characteristic, int status) {
            gattProbe.onCharacteristicRead(bluetoothGatt, characteristic, status);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt bluetoothGatt, BluetoothGattCharacteristic characteristic) {
            gattProbe.onCharacteristicChanged(characteristic);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt bluetoothGatt, BluetoothGattDescriptor descriptor, int status) {
            gattProbe.onDescriptorWrite(descriptor, status);
        }
    };

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private boolean scanning;

    public XiaomiBleProbeController(Context context, Handler handler, Listener listener) {
        this.context = context;
        this.handler = handler;
        this.listener = listener;
        this.gattProbe = new XiaomiBleGattProbe(handler, this::log);
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        bluetoothAdapter = manager == null ? null : manager.getAdapter();
        if (bluetoothAdapter != null) {
            scanner = bluetoothAdapter.getBluetoothLeScanner();
        }
    }

    public void startScan() {
        if (bluetoothAdapter == null || scanner == null) {
            log("蓝牙低功耗扫描器不可用。");
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            log("蓝牙未开启。");
            return;
        }
        scanResults.clear();
        publishDevices();
        log("正在扫描附近的 BLE 设备...");
        scanner.startScan(scanCallback);
        setScanning(true);
        handler.postDelayed(this::stopScan, 15000);
    }

    public void stopScan() {
        if (scanner != null && scanning) {
            scanner.stopScan(scanCallback);
        }
        setScanning(false);
    }

    public void close() {
        stopScan();
        if (gatt != null) {
            gatt.close();
            gatt = null;
        }
    }

    public void connect(String address) {
        ScanResult result = scanResults.get(address);
        if (result == null) {
            log("未找到设备：" + address);
            return;
        }
        stopScan();
        BluetoothDevice device = result.getDevice();
        log("");
        log("已选择：" + XiaomiBleFormatter.safeName(device) + " " + XiaomiBleFormatter.safeAddress(device) + "，信号=" + result.getRssi());
        log("广播信息：" + XiaomiBleFormatter.describeAdvertisement(result));
        if (gatt != null) {
            gatt.close();
            gatt = null;
        }
        log("正在连接 GATT...");
        gatt = device.connectGatt(context, false, gattCallback);
    }

    private void publishDevices() {
        handler.post(() -> listener.onDevicesChanged(scanResults.deviceEntries()));
    }

    private void setScanning(boolean value) {
        scanning = value;
        handler.post(() -> listener.onScanningChanged(value));
    }

    private void log(String message) {
        listener.onLog(message);
    }

    public static final class DeviceEntry {
        public final String address;
        public final String name;
        public final int rssi;
        public final String signalLabel;

        DeviceEntry(String address, String name, int rssi, String signalLabel) {
            this.address = address;
            this.name = name;
            this.rssi = rssi;
            this.signalLabel = signalLabel == null ? "" : signalLabel;
        }
    }
}
