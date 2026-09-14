package com.rabi.link

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

class BondedGattProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        val probe = BondedGattProbe(context.applicationContext) {
            pendingResult.finish()
        }
        probe.start()
    }
}

private class BondedGattProbe(
    private val context: Context,
    private val finish: () -> Unit
) {
    private val tag = "RabiBondedGatt"
    private val handler = Handler(Looper.getMainLooper())
    private val readQueue = ArrayDeque<BluetoothGattCharacteristic>()
    private var gatt: BluetoothGatt? = null
    private var finished = false

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            log("GATT 状态变化：status=$status state=$newState")
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    log("已连接，开始发现服务")
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    complete("GATT 已断开")
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            log("服务发现完成：status=$status")
            if (status != BluetoothGatt.GATT_SUCCESS) {
                complete("服务发现失败")
                return
            }

            val services = gatt.services
            log("服务数量：${services.size}")
            services.forEach { service ->
                log("服务 ${shortUuid(service.uuid)} 特征数=${service.characteristics.size}")
                service.characteristics.forEach { characteristic ->
                    val props = describeProperties(characteristic.properties)
                    log("  特征 ${shortUuid(characteristic.uuid)} props=$props")
                    if ((characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ) != 0) {
                        readQueue.add(characteristic)
                    }
                }
            }
            readNext()
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            log("读取 ${shortUuid(characteristic.uuid)}：status=$status value=${decodeValue(characteristic)}")
            handler.postDelayed({ readNext() }, 180)
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            log("读取 ${shortUuid(characteristic.uuid)}：status=$status value=${decodeBytes(characteristic, value)}")
            handler.postDelayed({ readNext() }, 180)
        }
    }

    fun start() {
        if (!hasBluetoothConnectPermission()) {
            complete("缺少 BLUETOOTH_CONNECT 权限")
            return
        }

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            complete("蓝牙不可用或未开启")
            return
        }

        val devices = adapter.bondedDevices.sortedBy { safeName(it) }
        log("已配对设备数量：${devices.size}")
        devices.forEach { device ->
            log("已配对：${safeName(device)} ${safeAddress(device)} type=${device.type} bond=${device.bondState}")
        }

        val target = devices.firstOrNull { device ->
            val name = safeName(device)
            val address = safeAddress(device)
            name.contains("Xiaomi Smart Band 10 Pro", ignoreCase = true) ||
                name.contains("Band 10 Pro", ignoreCase = true) ||
                address.endsWith(":25:CC", ignoreCase = true)
        }

        if (target == null) {
            complete("未在已配对列表找到 Xiaomi Smart Band 10 Pro")
            return
        }

        log("目标设备：${safeName(target)} ${safeAddress(target)} type=${target.type}")
        handler.postDelayed({ complete("GATT 探测超时") }, 30000)
        gatt = if (Build.VERSION.SDK_INT >= 23) {
            target.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        } else {
            target.connectGatt(context, false, callback)
        }
        log("connectGatt 已调用")
    }

    private fun readNext() {
        val currentGatt = gatt ?: return
        val characteristic = readQueue.poll()
        if (characteristic == null) {
            complete("可读特征读取完成")
            return
        }
        val started = currentGatt.readCharacteristic(characteristic)
        log("请求读取 ${shortUuid(characteristic.uuid)}：$started")
        if (!started) {
            handler.postDelayed({ readNext() }, 180)
        }
    }

    private fun complete(message: String) {
        if (finished) {
            return
        }
        finished = true
        log(message)
        runCatching {
            gatt?.disconnect()
            gatt?.close()
        }
        gatt = null
        finish()
    }

    private fun hasBluetoothConnectPermission(): Boolean {
        return Build.VERSION.SDK_INT < 31 ||
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    }

    private fun safeName(device: BluetoothDevice): String {
        return runCatching { device.name ?: "" }.getOrDefault("")
    }

    private fun safeAddress(device: BluetoothDevice): String {
        return runCatching { device.address ?: "" }.getOrDefault("")
    }

    private fun decodeValue(characteristic: BluetoothGattCharacteristic): String {
        return decodeBytes(characteristic, characteristic.value)
    }

    private fun decodeBytes(characteristic: BluetoothGattCharacteristic, value: ByteArray?): String {
        if (value == null) {
            return "<null>"
        }
        if (characteristic.uuid == uuid16(0x2A19) && value.isNotEmpty()) {
            return "${value[0].toInt() and 0xff}% raw=${bytesToHex(value)}"
        }
        if (looksText(value)) {
            return "\"${String(value, StandardCharsets.UTF_8).trim()}\" raw=${bytesToHex(value)}"
        }
        return bytesToHex(value)
    }

    private fun describeProperties(properties: Int): String {
        val names = mutableListOf<String>()
        if ((properties and BluetoothGattCharacteristic.PROPERTY_READ) != 0) names += "READ"
        if ((properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) names += "WRITE"
        if ((properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) names += "WRITE_NO_RESPONSE"
        if ((properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) names += "NOTIFY"
        if ((properties and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) names += "INDICATE"
        return if (names.isEmpty()) "0x${properties.toString(16)}" else names.joinToString("|")
    }

    private fun log(message: String) {
        Log.i(tag, message)
    }
}

private fun uuid16(value: Int): UUID {
    return UUID.fromString(String.format(Locale.US, "0000%04x-0000-1000-8000-00805f9b34fb", value))
}

private fun shortUuid(uuid: UUID): String {
    val text = uuid.toString()
    return if (text.startsWith("0000") && text.endsWith("-0000-1000-8000-00805f9b34fb")) {
        "0x" + text.substring(4, 8).uppercase(Locale.US)
    } else {
        text
    }
}

private fun bytesToHex(bytes: ByteArray): String {
    return bytes.joinToString("") { "%02X".format(it) }
}

private fun looksText(value: ByteArray): Boolean {
    if (value.isEmpty()) return false
    return value.all { byte ->
        val c = byte.toInt() and 0xff
        c in 0x20..0x7e
    }
}
