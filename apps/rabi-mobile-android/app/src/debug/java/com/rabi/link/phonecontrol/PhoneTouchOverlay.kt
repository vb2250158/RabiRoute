package com.rabi.link.phonecontrol

import android.accessibilityservice.AccessibilityService
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.WindowManager.LayoutParams
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/** Shows accepted Android gestures on the target display. It never participates in input routing. */
internal class PhoneTouchOverlay(private val service: AccessibilityService, private val main: Handler) {
    private val windows = service.getSystemService(WindowManager::class.java)
    private val view = MarkerView(service)
    @Volatile private var owner: String? = null
    @Volatile private var visible = false
    private val readers = AtomicInteger()
    private val dismiss = Runnable { clear() }

    fun show(marker: PhoneTouchFeedback) {
        main.removeCallbacks(dismiss)
        view.update(marker)
        owner = marker.requestId
        syncVisibility()
        main.postAtTime(dismiss, marker.endsAt)
    }

    fun suspendForCapture(): AutoCloseable {
        if (readers.incrementAndGet() == 1 && visible) main.post { syncVisibility() }
        return AutoCloseable { if (readers.decrementAndGet() == 0 && owner != null) main.post { syncVisibility() } }
    }

    private fun syncVisibility() {
        val show = owner != null && readers.get() == 0
        if (show == visible) return
        if (show) {
            val params = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT,
                LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCHABLE or
                    LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT)
            params.gravity = Gravity.TOP or Gravity.LEFT
            params.title = "RabiLink touch feedback"
            if (Build.VERSION.SDK_INT >= 28) params.layoutInDisplayCutoutMode = LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            if (Build.VERSION.SDK_INT >= 30) params.fitInsetsTypes = 0
            // Rendering feedback is independent of the gesture already handed to Android.
            PhoneInputAccess.feedbackVisible()
            try {
                windows.addView(view, params)
                visible = true
                // A capture may have started during the WindowManager call.
                if (readers.get() > 0) main.post { syncVisibility() }
            }
            catch (error: RuntimeException) {
                owner = null
                PhoneInputAccess.feedbackHidden()
                android.util.Log.w("RabiPhoneTouch", "Touch feedback unavailable: ${error.javaClass.simpleName}")
            }
        } else {
            try { windows.removeViewImmediate(view) }
            catch (_: IllegalArgumentException) { /* Android already removed the window. */ }
            finally {
                visible = false
                PhoneInputAccess.feedbackHidden()
            }
        }
    }

    fun clear(requestId: String? = null) {
        if (owner == null || requestId != null && owner != requestId) return
        owner = null
        main.removeCallbacks(dismiss)
        syncVisibility()
    }

    private class MarkerView(service: AccessibilityService) : View(service) {
        private val pixels = resources.displayMetrics.density
        private val location = IntArray(2)
        private val ink = Paint(Paint.ANTI_ALIAS_FLAG)
        private val labelInk = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 13 * pixels }
        private var marker: PhoneTouchFeedback? = null

        init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }

        fun update(marker: PhoneTouchFeedback) {
            this.marker = marker
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val marker = marker ?: return
            val action = marker.action
            val now = SystemClock.uptimeMillis()
            getLocationOnScreen(location)
            val startX = action.x - location[0]
            val startY = action.y - location[1]
            val swipe = action.kind == "swipe"
            val (currentX, currentY) = marker.position(now)
            val x = currentX - location[0]
            val y = currentY - location[1]
            val tint = Color.rgb(55, 223, 197)
            ink.color = tint
            ink.strokeWidth = 3 * pixels
            ink.strokeCap = Paint.Cap.ROUND
            if (swipe) canvas.drawLine(startX, startY, x, y, ink)
            canvas.drawCircle(x, y, 9 * pixels, ink)
            ink.color = Color.rgb(15, 28, 37)
            canvas.drawCircle(x, y, 5 * pixels, ink)

            val maxLabelWidth = min(196 * pixels, width - 24 * pixels)
            if (maxLabelWidth > 0) {
                val label = TextUtils.ellipsize(marker.label, labelInk, maxLabelWidth, TextUtils.TruncateAt.END).toString()
                val labelWidth = labelInk.measureText(label) + 12 * pixels
                val labelHeight = 23 * pixels
                val desiredLeft = if (x + labelWidth + 14 * pixels < width) x + 12 * pixels else x - labelWidth - 12 * pixels
                val left = desiredLeft.coerceIn(0f, (width - labelWidth).coerceAtLeast(0f))
                val top = (y - labelHeight / 2).coerceIn(0f, (height - labelHeight).coerceAtLeast(0f))
                canvas.drawRoundRect(left, top, left + labelWidth, top + labelHeight, 5 * pixels, 5 * pixels, ink)
                canvas.drawText(label, left + 6 * pixels, top + 16 * pixels, labelInk)
            }
            if (swipe && now < marker.startedAt + action.durationMs) postInvalidateOnAnimation()
        }
    }
}
