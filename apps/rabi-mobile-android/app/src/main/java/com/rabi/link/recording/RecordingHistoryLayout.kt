package com.rabi.link.recording

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.LinearLayout
import kotlin.math.abs

/** Collapses the entire live pane when history scrolling begins. Row taps keep their normal dispatch. */
internal class RecordingHistoryLayout(context: Context) : LinearLayout(context) {
    var canStartHistoryGesture: (Float, Float) -> Boolean = { _, _ -> false }
    var shouldCollapseLive: () -> Boolean = { false }
    var scrollHistoryBy: (Float) -> Unit = {}
    var collapseBy: (Float) -> Float = { 0f }
    var finishCollapse: () -> Unit = {}
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var startX = 0f
    private var startY = 0f
    private var lastY = 0f
    private var candidate = false
    private var collapsing = false

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        when(event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.rawX; startY = event.rawY; lastY = startY
                collapsing = false; candidate = canStartHistoryGesture(startX,startY)
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = event.rawY-startY
                if(candidate && abs(dy) > slop && abs(dy) > abs(event.rawX-startX) && shouldCollapseLive()) {
                    collapsing = true; parent?.requestDisallowInterceptTouchEvent(true)
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if(!collapsing) candidate = false
        }
        return collapsing || super.onInterceptTouchEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if(!collapsing) return super.onTouchEvent(event)
        when(event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val dy = event.rawY-lastY
                lastY = event.rawY
                val remainder = collapseBy(kotlin.math.abs(dy))
                if(remainder > 0f) scrollHistoryBy(if(dy < 0) -remainder else remainder)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                collapsing = false; candidate = false
                finishCollapse()
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return true
    }
}
