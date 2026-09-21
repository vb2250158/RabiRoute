package com.rabi.link.recording

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Bundle
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.OverScroller
import com.rabi.link.RabiMobileUi
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Draws only the visible clock window; dragging moves time beneath a fixed cursor. */
class RecordingTimeRuler(context: Context) : View(context) {
    data class Coverage(val start: Long, val duration: Long, val video: Boolean)
    var onMove: (Long, Boolean) -> Unit = { _, _ -> }
    var onStart: () -> Unit = {}
    var time = System.currentTimeMillis(); private set
    var window = 30 * 60_000L; private set
    private var live = true
    private var touching = false
    private var flinging = false
    private var lastFlingX = 0
    private val scroller = OverScroller(context)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var coverage = emptyList<Coverage>()
    private val density = resources.displayMetrics.density
    private fun d(value: Int) = value * density
    private val scale = ScaleGestureDetector(context,object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            window = TimelineRulerMath.zoom(window,detector.scaleFactor.toDouble()); changed(false); return true
        }
    })
    private val gestures = GestureDetector(context,object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean { scroller.forceFinished(true); flinging = false; touching = true; onStart(); return true }
        override fun onScroll(first: MotionEvent?, next: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if(!scale.isInProgress) { time = TimelineRulerMath.pan(time,-distanceX.toDouble(),width,window,System.currentTimeMillis()); changed(false) }
            return true
        }
        override fun onFling(first: MotionEvent?, next: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            if(scale.isInProgress) return false
            lastFlingX = 0; flinging = true
            scroller.fling(0,0,velocityX.toInt(),0,-1_000_000,1_000_000,0,0); postInvalidateOnAnimation(); return true
        }
        override fun onSingleTapUp(e: MotionEvent): Boolean { performClick(); return true }
        override fun onDoubleTap(e: MotionEvent): Boolean { window = TimelineRulerMath.zoom(window,2.0); changed(false); return true }
    })
    init { isFocusable = true; contentDescription = "记录时间尺，左右滚动回看，双指缩放，最新时刻为实时" }
    fun setCoverage(value: List<Coverage>) { coverage = value; invalidate() }
    fun setPosition(value: Long, isLive: Boolean) {
        if(touching || flinging) return
        time = value.coerceIn(0,System.currentTimeMillis()); live = isLive; invalidate()
    }
    fun showDay(value: Long) { cancelGesture(); window = 86_400_000; setPosition(value,false) }
    fun visibleRange() = TimelineRulerMath.range(time,window)
    fun cancelGesture() { scroller.forceFinished(true); touching = false; flinging = false }
    private fun changed(finished: Boolean) {
        val now = System.currentTimeMillis()
        live = time >= now - 1000
        if(live) time = now
        invalidate(); onMove(time,finished)
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        scale.onTouchEvent(event); gestures.onTouchEvent(event)
        if(event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            touching = false
            if(event.actionMasked == MotionEvent.ACTION_CANCEL) { scroller.forceFinished(true); flinging = false }
            if(!flinging) changed(true)
            parent?.requestDisallowInterceptTouchEvent(false)
        }
        return true
    }
    override fun performClick(): Boolean { super.performClick(); return true }
    override fun computeScroll() {
        if(!flinging) return
        if(scroller.computeScrollOffset()) {
            time = TimelineRulerMath.pan(time,(scroller.currX-lastFlingX).toDouble(),width,window,System.currentTimeMillis()); lastFlingX = scroller.currX
            changed(false)
            if(time >= System.currentTimeMillis()-1000 || time == 0L) scroller.abortAnimation()
            postInvalidateOnAnimation()
        } else { flinging = false; changed(true) }
    }
    override fun onDetachedFromWindow() { cancelGesture(); super.onDetachedFromWindow() }
    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info); info.isScrollable = true
        info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
        info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
    }
    override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
        if(action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD || action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) {
            onStart(); time = (time + if(action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) -window/4 else window/4).coerceIn(0,System.currentTimeMillis()); changed(true); return true
        }
        return super.performAccessibilityAction(action,arguments)
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val range = visibleRange(); val center = width / 2f
        fun x(value: Long) = center + ((value-time).toDouble()/window*width).toFloat()
        // A thin visual track retains a 64dp touch surface inside the preview.
        canvas.drawColor(0xB3191D22.toInt())
        paint.color = android.graphics.Color.LTGRAY; paint.textSize = d(10); paint.textAlign = Paint.Align.LEFT
        canvas.drawText("绿色 ASR · 青色 录像",d(10),d(58),paint)
        paint.textAlign = Paint.Align.RIGHT; canvas.drawText("双指缩放",width-d(10),d(58),paint)
        val step = TimelineRulerMath.majorStep(window,width/density)
        val minor = step/5
        var tick = Math.floorDiv(range.first,minor)*minor
        val format = SimpleDateFormat(if(step >= 86_400_000) "M/d" else if(step < 60_000) "HH:mm:ss" else "HH:mm",Locale.CHINA)
        paint.strokeWidth = density; paint.textSize = d(10); paint.textAlign = Paint.Align.CENTER
        while(tick <= range.last && tick <= System.currentTimeMillis()) {
            val major = tick % step == 0L
            paint.color = if(major) android.graphics.Color.LTGRAY else 0x88FFFFFF.toInt()
            canvas.drawLine(x(tick),d(24),x(tick),d(if(major) 31 else 28),paint)
            if(major && kotlin.math.abs(x(tick)-center)>d(38)) canvas.drawText(format.format(Date(tick)),x(tick),d(17),paint)
            tick += minor
        }
        paint.color = 0x55FFFFFF; paint.strokeWidth = d(2)
        canvas.drawLine(0f,d(37),width.toFloat(),d(37),paint)
        coverage.forEach { span ->
            if(TimelineRulerMath.overlaps(span.start,span.duration,range)) {
                paint.color = if(span.video) RabiMobileUi.secondary else android.graphics.Color.rgb(38,185,120)
                val left = x(span.start).coerceAtLeast(0f); val right = x(span.start+span.duration).coerceAtMost(width.toFloat())
                canvas.drawRoundRect(left,d(if(span.video) 39 else 34),maxOf(left+d(2),right),d(if(span.video) 42 else 37),d(1),d(1),paint)
            }
        }
        paint.color = android.graphics.Color.WHITE; paint.strokeWidth = d(1)
        canvas.drawLine(center,d(23),center,d(44),paint)
        canvas.drawCircle(center,d(37),d(3),paint)
        paint.textSize = d(11); paint.textAlign = Paint.Align.CENTER
        canvas.drawText((if(live) "实时 · " else "")+SimpleDateFormat("HH:mm:ss",Locale.CHINA).format(Date(time)),center,d(17),paint)
    }
}
