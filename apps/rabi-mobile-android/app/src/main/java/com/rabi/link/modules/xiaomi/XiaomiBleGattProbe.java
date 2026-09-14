package com.rabi.link.modules.xiaomi;

import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.os.Handler;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Queue;
import java.util.UUID;

final class XiaomiBleGattProbe {
    interface Logger {
        void log(String message);
    }

    private final Handler handler;
    private final Logger logger;
    private final Queue<BluetoothGattCharacteristic> readQueue = new ArrayDeque<>();

    XiaomiBleGattProbe(Handler handler, Logger logger) {
        this.handler = handler;
        this.logger = logger;
    }

    void onServicesDiscovered(BluetoothGatt bluetoothGatt, int status) {
        log("服务发现完成：status=" + status);
        if (status != BluetoothGatt.GATT_SUCCESS) {
            return;
        }
        inspectServices(bluetoothGatt);
    }

    void onCharacteristicRead(BluetoothGatt bluetoothGatt, BluetoothGattCharacteristic characteristic, int status) {
        log("读取 " + XiaomiBleProfiles.shortUuid(characteristic.getUuid()) + "：status=" + status + "，值=" + XiaomiBleFormatter.decodeValue(characteristic));
        handler.postDelayed(() -> readNext(bluetoothGatt), 150);
    }

    void onCharacteristicChanged(BluetoothGattCharacteristic characteristic) {
        if (XiaomiBleProfiles.HEART_RATE_MEASUREMENT.equals(characteristic.getUuid())) {
            log("实时心率：" + XiaomiBleFormatter.parseHeartRate(characteristic.getValue()) + " bpm，原始数据=" + XiaomiBleFormatter.bytesToHex(characteristic.getValue()));
        } else {
            log("收到通知 " + XiaomiBleProfiles.shortUuid(characteristic.getUuid()) + "：" + XiaomiBleFormatter.bytesToHex(characteristic.getValue()));
        }
    }

    void onDescriptorWrite(BluetoothGattDescriptor descriptor, int status) {
        log("写入描述符 " + XiaomiBleProfiles.shortUuid(descriptor.getUuid()) + "：status=" + status);
    }

    private void inspectServices(BluetoothGatt bluetoothGatt) {
        List<BluetoothGattService> services = bluetoothGatt.getServices();
        log("服务数量：" + services.size());
        for (BluetoothGattService service : services) {
            log("服务 " + XiaomiBleProfiles.shortUuid(service.getUuid()) + "，特征数量=" + service.getCharacteristics().size());
        }

        enqueueReadable(bluetoothGatt, XiaomiBleProfiles.DEVICE_INFORMATION_SERVICE);
        enqueueReadable(bluetoothGatt, XiaomiBleProfiles.BATTERY_SERVICE);
        subscribeHeartRate(bluetoothGatt);
        readNext(bluetoothGatt);
    }

    private void enqueueReadable(BluetoothGatt bluetoothGatt, UUID serviceUuid) {
        BluetoothGattService service = bluetoothGatt.getService(serviceUuid);
        if (service == null) {
            log("未发现服务：" + XiaomiBleProfiles.shortUuid(serviceUuid));
            return;
        }
        for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
            if ((characteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_READ) != 0) {
                readQueue.add(characteristic);
            }
        }
    }

    private void readNext(BluetoothGatt bluetoothGatt) {
        BluetoothGattCharacteristic next = readQueue.poll();
        if (next == null) {
            log("公开可读特征读取完成。");
            return;
        }
        boolean started = bluetoothGatt.readCharacteristic(next);
        log("请求读取 " + XiaomiBleProfiles.shortUuid(next.getUuid()) + "：" + started);
        if (!started) {
            handler.postDelayed(() -> readNext(bluetoothGatt), 150);
        }
    }

    private void subscribeHeartRate(BluetoothGatt bluetoothGatt) {
        BluetoothGattService service = bluetoothGatt.getService(XiaomiBleProfiles.HEART_RATE_SERVICE);
        if (service == null) {
            log("未发现心率服务。请先在手环开启“心率广播 / Share HR”，然后重新扫描。");
            return;
        }
        BluetoothGattCharacteristic measurement = service.getCharacteristic(XiaomiBleProfiles.HEART_RATE_MEASUREMENT);
        if (measurement == null) {
            log("未发现心率测量特征。");
            return;
        }
        boolean notifyEnabled = bluetoothGatt.setCharacteristicNotification(measurement, true);
        log("启用本地心率通知：" + notifyEnabled);
        BluetoothGattDescriptor descriptor = measurement.getDescriptor(XiaomiBleProfiles.CLIENT_CHARACTERISTIC_CONFIG);
        if (descriptor == null) {
            log("未发现心率 CCC 描述符。");
            return;
        }
        descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        boolean writeStarted = bluetoothGatt.writeDescriptor(descriptor);
        log("启用远端心率通知：" + writeStarted);
    }

    private void log(String message) {
        logger.log(message);
    }
}
