package com.rabi.link.modules.xiaomi;

import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.le.ScanResult;

import java.nio.charset.StandardCharsets;
import java.util.List;

final class XiaomiBleFormatter {
    private XiaomiBleFormatter() {
    }

    static String describeAdvertisement(ScanResult result) {
        if (result.getScanRecord() == null) {
            return "<没有广播记录>";
        }
        StringBuilder builder = new StringBuilder();
        builder.append("名称=").append(result.getScanRecord().getDeviceName());
        builder.append("，服务=").append(result.getScanRecord().getServiceUuids());
        builder.append("，厂商数据=");
        android.util.SparseArray<byte[]> manufacturer = result.getScanRecord().getManufacturerSpecificData();
        if (manufacturer == null || manufacturer.size() == 0) {
            builder.append("{}");
        } else {
            builder.append("{");
            for (int i = 0; i < manufacturer.size(); i++) {
                if (i > 0) {
                    builder.append(", ");
                }
                builder.append(manufacturer.keyAt(i)).append(":").append(bytesToHex(manufacturer.valueAt(i)));
            }
            builder.append("}");
        }
        return builder.toString();
    }

    static String signalLabel(ScanResult result) {
        if (result.getScanRecord() == null) {
            return "";
        }
        List<android.os.ParcelUuid> uuids = result.getScanRecord().getServiceUuids();
        if (uuids != null) {
            for (android.os.ParcelUuid parcelUuid : uuids) {
                if (XiaomiBleProfiles.HEART_RATE_SERVICE.equals(parcelUuid.getUuid())) {
                    return " HR";
                }
            }
        }
        return "";
    }

    static String decodeValue(BluetoothGattCharacteristic characteristic) {
        byte[] value = characteristic.getValue();
        if (value == null) {
            return "<null>";
        }
        if (XiaomiBleProfiles.BATTERY_SERVICE.equals(characteristic.getService().getUuid()) && value.length > 0) {
            return (value[0] & 0xFF) + "%，原始数据=" + bytesToHex(value);
        }
        if (looksText(value)) {
            return "\"" + new String(value, StandardCharsets.UTF_8).trim() + "\"，原始数据=" + bytesToHex(value);
        }
        return bytesToHex(value);
    }

    static int parseHeartRate(byte[] value) {
        if (value == null || value.length < 2) {
            return -1;
        }
        boolean sixteenBit = (value[0] & 0x01) == 0x01;
        if (sixteenBit && value.length >= 3) {
            return (value[1] & 0xFF) | ((value[2] & 0xFF) << 8);
        }
        return value[1] & 0xFF;
    }

    static String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return "<null>";
        }
        char[] hexArray = "0123456789ABCDEF".toCharArray();
        char[] hexChars = new char[bytes.length * 2];
        for (int j = 0; j < bytes.length; j++) {
            int v = bytes[j] & 0xFF;
            hexChars[j * 2] = hexArray[v >>> 4];
            hexChars[j * 2 + 1] = hexArray[v & 0x0F];
        }
        return new String(hexChars);
    }

    static String safeName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null || name.trim().isEmpty() ? "<未命名设备>" : name;
        } catch (SecurityException e) {
            return "<权限不足>";
        }
    }

    static String safeAddress(BluetoothDevice device) {
        try {
            return device.getAddress();
        } catch (SecurityException e) {
            return null;
        }
    }

    private static boolean looksText(byte[] value) {
        if (value.length == 0) {
            return false;
        }
        for (byte b : value) {
            int c = b & 0xFF;
            if (c == 0) {
                return false;
            }
            if (c < 0x20 || c > 0x7E) {
                return false;
            }
        }
        return true;
    }
}
