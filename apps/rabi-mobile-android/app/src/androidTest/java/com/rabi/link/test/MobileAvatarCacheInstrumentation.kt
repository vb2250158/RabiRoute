package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Build
import android.os.Bundle
import android.widget.ImageView
import com.rabi.link.RabiAvatarLoadRules
import com.rabi.link.RabiChatStore
import com.rabi.link.RabiPersonaAvatarCache
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MobileAvatarCacheInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val report = Bundle()
        try {
            check(targetContext.packageName.endsWith(".assistantacceptance"))
            val scope = UUID.randomUUID().toString()
            val calls = AtomicInteger()
            val served = CountDownLatch(2)
            val release = CountDownLatch(1)
            val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.BLUE)
            val bytes = ByteArrayOutputStream().also { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray()
            bitmap.recycle()
            val fetch = {
                calls.incrementAndGet()
                check(release.await(5, TimeUnit.SECONDS))
                bytes
            }
            lateinit var first: ImageView
            runOnMainSync {
                first = ImageView(targetContext)
                for (image in listOf(first, ImageView(targetContext))) {
                    RabiPersonaAvatarCache.load(targetContext, image, scope, "role", "v1", fetch) { state ->
                        if (state == RabiAvatarLoadRules.State.READY) served.countDown()
                    }
                }
            }
            release.countDown()
            check(served.await(10, TimeUnit.SECONDS) && calls.get() == 1)
            val failed = CountDownLatch(1)
            runOnMainSync {
                val redrawn = ImageView(targetContext)
                RabiPersonaAvatarCache.load(targetContext, redrawn, scope, "role", "v1", fetch)
                check((redrawn.drawable as BitmapDrawable).bitmap.getPixel(0, 0) == Color.BLUE)
                val previous = (first.drawable as BitmapDrawable).bitmap
                RabiPersonaAvatarCache.load(targetContext, first, scope, "role", "v2", {
                    calls.incrementAndGet()
                    error("Offline fixture")
                }) { state ->
                    if (state == RabiAvatarLoadRules.State.STALE && calls.get() == 2) failed.countDown()
                }
                check((first.drawable as BitmapDrawable).bitmap === previous)
            }
            check(failed.await(10, TimeUnit.SECONDS))
            runOnMainSync {
                check((first.drawable as BitmapDrawable).bitmap.getPixel(0, 0) == Color.BLUE)
                RabiPersonaAvatarCache.load(targetContext, first, scope, "role", "v2", fetch)
            }
            check(calls.get() == 2)
            report.putString("result", "PASS: requests coalesced, redraw reused the bitmap, and failed update kept the previous avatar")
            verifyChatStoreEvents()
            report.putString("chatEvents", "PASS: message and list mutations notify; duplicate writes and drafts stay quiet")
            finish(Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("error", error.message ?: error.javaClass.simpleName)
            finish(Activity.RESULT_CANCELED, report)
        }
    }

    private fun verifyChatStoreEvents() {
        val route = UUID.randomUUID().toString()
        val message = UUID.randomUUID().toString()
        val events = mutableListOf<Boolean>()
        val received = CountDownLatch(3)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.getStringExtra(RabiChatStore.EXTRA_CONVERSATION_ID) == route) {
                    events.add(intent.getBooleanExtra(RabiChatStore.EXTRA_LIST_STATE_ONLY, false))
                    received.countDown()
                }
            }
        }
        val filter = IntentFilter(RabiChatStore.ACTION_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) targetContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else {
            @Suppress("DEPRECATION")
            targetContext.registerReceiver(receiver, filter)
        }
        try {
            val store = RabiChatStore(targetContext)
            store.append(message, "user", "text", "fixture", "", "text/plain", route)
            store.append(message, "user", "text", "fixture", "", "text/plain", route)
            store.saveDraft(route, "fixture draft")
            store.updateDelivery(message, "sending", "")
            store.updateDelivery(message, "sending", "")
            store.markUnread(route)
            store.markUnread(route)
            check(received.await(10, TimeUnit.SECONDS))
            waitForIdleSync()
            runOnMainSync { check(events == listOf(false, false, true)) }
        } finally {
            targetContext.unregisterReceiver(receiver)
        }
    }
}
