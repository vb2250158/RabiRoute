package com.rabi.link.location

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.amap.api.location.AMapLocation
import com.amap.api.location.AMapLocationClient
import com.amap.api.location.AMapLocationClientOption
import com.amap.api.location.CoordinateConverter
import com.amap.api.location.DPoint
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** One bounded Android SDK fix. Raw SDK diagnostics may contain key/signature; never surface them. */
class AmapLocationLookup(private val context: Context, private val reserve: () -> Boolean) : AutoCloseable {
    private val main = Handler(Looper.getMainLooper())
    private val done = CountDownLatch(1)
    private val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
    private var client: AMapLocationClient? = null
    fun resolve(key: String, point: LocationPoint? = null): String {
        check(Looper.myLooper() != Looper.getMainLooper())
        check(LocationSettings(context).privacyAccepted) { "请先阅读并同意高德定位隐私说明" }
        check(key.isNotBlank()) { "请先保存高德 Android Key" }
        check(!cancelled.get() && reserve()) { "已达到本机月调用上限，系统 GPS 继续记录" }
        val answer = AtomicReference<Result<String>>()
        main.post {
            if(cancelled.get()) return@post
            try {
                AMapLocationClient.updatePrivacyShow(context, true, true)
                AMapLocationClient.updatePrivacyAgree(context, true)
                AMapLocationClient.setApiKey(key)
                client = AMapLocationClient(context.applicationContext).apply {
                    setLocationOption(AMapLocationClientOption().apply {
                        locationMode = AMapLocationClientOption.AMapLocationMode.Battery_Saving
                        isOnceLocation = true
                        isOnceLocationLatest = true
                        isNeedAddress = true
                        isLocationCacheEnable = false
                        httpTimeOut = com.rabi.link.transport.ScopedManagerTimeouts.active(context).get("android.location.http",10000)
                        AMapLocationClientOption.setLocationProtocol(AMapLocationClientOption.AMapLocationProtocol.HTTPS)
                    })
                    setLocationListener { location ->
                        if(!cancelled.get()) {
                            answer.compareAndSet(null, runCatching { label(location, point) })
                            done.countDown()
                        }
                    }
                    startLocation()
                }
            } catch (_: Exception) {
                answer.set(Result.failure(IllegalStateException("高德定位初始化失败，请检查权限和 Android Key")))
                done.countDown()
            }
        }
        try {
            if(!done.await(com.rabi.link.transport.ScopedManagerTimeouts.active(context).get("android.location.lookup",20000), TimeUnit.MILLISECONDS)) throw IllegalStateException("高德定位超时，系统 GPS 继续记录")
            return answer.get()?.getOrThrow() ?: throw IllegalStateException("高德没有返回位置")
        } finally {
            close()
        }
    }
    override fun close() {
        cancelled.set(true)
        done.countDown()
        main.post { runCatching { client?.stopLocation(); client?.onDestroy() }; client = null }
    }
    private fun label(location: AMapLocation?, original: LocationPoint?): String {
        check(location != null) { "高德没有返回位置" }
        check(location.errorCode == 0) { "高德定位失败（${location.errorCode}），请检查 Android Key、包名、签名与网络" }
        if(original != null) {
            val reference = if(location.coordType == "GCJ02") CoordinateConverter(context).from(CoordinateConverter.CoordType.GPS)
                .coord(DPoint(original.latitude, original.longitude)).convert() else DPoint(original.latitude,original.longitude)
            check(location.coordType == "GCJ02" || location.coordType == "WGS84") { "高德坐标类型无法匹配，原始坐标已保留" }
            val distance = LocationPolicy.distance(original.copy(latitude=reference.latitude,longitude=reference.longitude),
                original.copy(latitude=location.latitude,longitude=location.longitude))
            check(location.accuracy > 0 && location.accuracy <= 200 && distance <= 150) { "高德地点与原位置不够接近，原始坐标已保留" }
        }
        return location.address?.takeIf { it.isNotBlank() } ?: throw IllegalStateException("高德定位成功，当前位置暂无地点名称")
    }
}
