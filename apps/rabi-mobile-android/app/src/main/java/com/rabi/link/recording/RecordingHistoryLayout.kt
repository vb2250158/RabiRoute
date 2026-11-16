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
    var canExpandLive: () -> Boolean = { false }
    var historyAtTop: () -> Boolean = { false }
    var expandBy: (Float) -> Unit = {}
    var finishExpansion: () -> Unit = {}
    var scrollHistoryBy: (Float) -> Unit = {}
    var collapseBy: (Float) -> Float = { 0f }
    var finishCollapse: () -> Unit = {}
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var startX = 0f
    private var startY = 0f
    private var lastY = 0f
    private var candidate = false
    private var collapsing = false
    private var expanding = false

    override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
        // AbsListView claims the gesture before our vertical slop check. Keep observing
        // history touches until the live pane has collapsed; horizontal taps still pass through.
        if(disallowIntercept && candidate && (shouldCollapseLive() || canExpandLive())) return
        super.requestDisallowInterceptTouchEvent(disallowIntercept)
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        when(event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.rawX; startY = event.rawY; lastY = startY
                collapsing = false; expanding = false; candidate = canStartHistoryGesture(startX,startY)
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = event.rawY-startY
                if(candidate && abs(dy) > slop && abs(dy) > abs(event.rawX-startX)) {
                    val returning = event.rawY > lastY && historyAtTop()
                    expanding = returning && canExpandLive()
                    collapsing = !expanding && shouldCollapseLive() && !returning
                    if(expanding || collapsing) {
                        parent?.requestDisallowInterceptTouchEvent(true)
                        return true
                    }
                }
                lastY = event.rawY
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if(!collapsing && !expanding) candidate = false
        }
        return collapsing || expanding || super.onInterceptTouchEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if(!collapsing && !expanding) return super.onTouchEvent(event)
        when(event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val dy = event.rawY-lastY
                lastY = event.rawY
                if(expanding) expandBy(dy)
                else {
                    val remainder = collapseBy(kotlin.math.abs(dy))
                    if(remainder > 0f) scrollHistoryBy(if(dy < 0) -remainder else remainder)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if(expanding) finishExpansion() else finishCollapse()
                collapsing = false; expanding = false; candidate = false
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return true
    }
}
