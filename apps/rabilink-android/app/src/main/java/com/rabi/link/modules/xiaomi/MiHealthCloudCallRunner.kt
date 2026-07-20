package com.rabi.link.modules.xiaomi

import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal object MiHealthCloudCallRunner {
    fun <T> callWithTimeout(timeoutSeconds: Long, block: () -> T): T {
        val executor = Executors.newSingleThreadExecutor()
        return try {
            val future = executor.submit(Callable { block() })
            future.get(timeoutSeconds, TimeUnit.SECONDS)
        } catch (error: TimeoutException) {
            throw RuntimeException("请求超过 ${timeoutSeconds}s 未返回", error)
        } finally {
            executor.shutdownNow()
        }
    }
}
