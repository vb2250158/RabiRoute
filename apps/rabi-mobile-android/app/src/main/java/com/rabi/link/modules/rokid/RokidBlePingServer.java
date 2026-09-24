package com.rabi.link.modules.rokid;

import android.annotation.SuppressLint;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;
import java.util.HashMap;
import java.util.Map;

/** Owned by the foreground diagnostic Activity; never owns recording or CXR sessions. */
@SuppressLint("MissingPermission")
public final class RokidBlePingServer implements AutoCloseable {
    public interface Listener { void onState(String state); }
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, byte[]> replies = new HashMap<>();
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertisement;
    private boolean active;
    private int generation;

    public RokidBlePingServer(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    private void report(String state) {
        Log.i("RabiBlePing", state);
        listener.onState(state);
    }

    public void start() {
        if (active) return;
        close();
        final int run = ++generation;
        try {
            BluetoothManager manager = context.getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) { report("蓝牙未开启"); return; }
            advertiser = adapter.getBluetoothLeAdvertiser();
            if (!adapter.isMultipleAdvertisementSupported() || advertiser == null) {
                report("手机不支持 BLE 外设广播"); return;
            }
            active = true;
            server = manager.openGattServer(context, new BluetoothGattServerCallback() {
                @Override public void onServiceAdded(int status, BluetoothGattService service) {
                    main.post(() -> {
                        if (!current(run)) return;
                        if (status != BluetoothGatt.GATT_SUCCESS) { fail("添加服务失败：" + status); return; }
                        if (RokidBlePingProtocol.SERVICE.equals(service.getUuid())) advertise(run);
                    });
                }
                @Override public void onConnectionStateChange(BluetoothDevice device, int status, int state) {
                    main.post(() -> {
                        if (!current(run)) return;
                        if (state == BluetoothProfile.STATE_DISCONNECTED) replies.remove(device.getAddress());
                        report(state == BluetoothProfile.STATE_CONNECTED ? "BLE 已连接，等待 ping" : "BLE 已断开：" + status);
                    });
                }
                @Override public void onCharacteristicWriteRequest(BluetoothDevice device, int id,
                        BluetoothGattCharacteristic characteristic, boolean prepared, boolean responseNeeded,
                        int offset, byte[] value) {
                    final byte[] copy = value == null ? null : value.clone();
                    main.post(() -> {
                        if (!current(run)) return;
                        byte[] pong = !prepared && offset == 0 && RokidBlePingProtocol.CHARACTERISTIC.equals(characteristic.getUuid())
                                ? RokidBlePingProtocol.reply(copy) : null;
                        int result = pong == null ? BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED : BluetoothGatt.GATT_SUCCESS;
                        if (pong != null) replies.put(device.getAddress(), pong);
                        if (responseNeeded) respond(device, id, result, 0, null);
                        report(pong == null ? "拒绝无效 ping（单包 ASCII，13 字节）" : "已收到 ping，等待客户端读取 pong");
                    });
                }
                @Override public void onCharacteristicReadRequest(BluetoothDevice device, int id, int offset,
                        BluetoothGattCharacteristic characteristic) {
                    main.post(() -> {
                        if (!current(run)) return;
                        byte[] pong = replies.get(device.getAddress());
                        boolean valid = offset == 0 && pong != null && RokidBlePingProtocol.CHARACTERISTIC.equals(characteristic.getUuid());
                        boolean sent = respond(device, id, valid ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, valid ? pong : null);
                        if (valid && sent) report("pong 已交给蓝牙栈；眼镜核对 nonce 后才算通过");
                    });
                }
                @Override public void onExecuteWrite(BluetoothDevice device, int id, boolean execute) {
                    main.post(() -> { if (current(run)) respond(device, id, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null); });
                }
            });
            if (server == null) { fail("无法打开 GATT 服务"); return; }
            BluetoothGattService service = new BluetoothGattService(RokidBlePingProtocol.SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            service.addCharacteristic(new BluetoothGattCharacteristic(RokidBlePingProtocol.CHARACTERISTIC,
                    BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_WRITE,
                    BluetoothGattCharacteristic.PERMISSION_READ | BluetoothGattCharacteristic.PERMISSION_WRITE));
            if (!server.addService(service)) { fail("系统拒绝添加 GATT 服务"); return; }
            report("正在添加 GATT 服务");
            main.postDelayed(() -> { if (current(run) && advertisement == null) fail("添加服务超时"); }, 10000);
        } catch (RuntimeException error) { fail("BLE 启动失败：" + error.getClass().getSimpleName()); }
    }

    private boolean current(int run) { return active && generation == run && server != null; }

    private boolean respond(BluetoothDevice device, int id, int status, int offset, byte[] value) {
        try {
            boolean sent = server.sendResponse(device, id, status, offset, value);
            if (!sent) report("GATT 响应未发送");
            return sent;
        } catch (RuntimeException error) { fail("GATT 响应失败：" + error.getClass().getSimpleName()); return false; }
    }

    private void advertise(int run) {
        advertisement = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settings) {
                main.post(() -> { if (current(run)) report("正在广播，等待眼镜 BLE 测试页连接"); });
            }
            @Override public void onStartFailure(int errorCode) {
                main.post(() -> { if (current(run)) fail("BLE 广播失败：" + errorCode); });
            }
        };
        try {
            AdvertiseSettings settings = new AdvertiseSettings.Builder().setConnectable(true)
                    .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY).setTimeout(0).build();
            AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(RokidBlePingProtocol.SERVICE))
                    .setIncludeDeviceName(false).build();
            advertiser.startAdvertising(settings, data, advertisement);
        } catch (RuntimeException error) { fail("广播启动失败：" + error.getClass().getSimpleName()); }
    }

    private void fail(String reason) { close(); report(reason); }

    @Override public void close() {
        active = false;
        generation++;
        main.removeCallbacksAndMessages(null);
        if (advertiser != null && advertisement != null) {
            try { advertiser.stopAdvertising(advertisement); }
            catch (RuntimeException error) { Log.w("RabiBlePing", "stopAdvertising failed", error); }
        }
        if (server != null) {
            try { server.close(); }
            catch (RuntimeException error) { Log.w("RabiBlePing", "GATT close failed", error); }
        }
        advertisement = null;
        advertiser = null;
        server = null;
        replies.clear();
    }
}
