package com.rabi.link.recording

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.DashPathEffect
import android.os.SystemClock
import android.view.View
import com.rabi.link.RabiMobileUi
import java.util.Locale

/** Mirrors WebGUI SpeechLevelWaveform: bottom-aligned bars, grid, state and measured level. */
class AudioWaveformView(context: Context, private val live: Boolean = false, private val compact: Boolean = false) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var levels = floatArrayOf()
    private val displayed = FloatArray(48)
    var progress = 0f
        set(value) { field = value.coerceIn(0f,1f); invalidate() }
    var state = if(live) "正在收音" else "录音回看"
        set(value) { field = value; invalidate() }
    private val refresh = object : Runnable {
        override fun run() {
            levels = AudioLevels.snapshot(SystemClock.elapsedRealtime())
            invalidate()
            postDelayed(this,if(compact) 33 else 100)
        }
    }
    init { contentDescription = "录音柱状声波" }
    fun setLevels(value: FloatArray) { levels = value; invalidate() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); if(live) post(refresh) }
    override fun onDetachedFromWindow() { removeCallbacks(refresh); super.onDetachedFromWindow() }
    private fun drawCompact(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val inset = 18*density; val center = height/2f
        val samples = levels.takeLast(48); val peak = samples.maxOrNull() ?: 0f
        val stride = (width-inset*2)/48
        canvas.drawColor(RabiMobileUi.surface)
        val threshold = EventSplitSettings.load(context).signalThreshold.toFloat()
        val scale = maxOf(0.04f,peak,threshold)*1.15f
        for(index in 0 until 48) {
            val value = samples.getOrNull(index-(48-samples.size)) ?: 0f
            val x = inset+index*stride
            val target = value/scale
            displayed[index] += (target-displayed[index]) * if(target > displayed[index]) 0.55f else 0.22f
            val edge = kotlin.math.sin(Math.PI*(index+0.5)/48).toFloat()
            val half = maxOf(1.5f*density,displayed[index]*edge*(height-12*density).coerceAtLeast(1f)/2)
            paint.color = if(displayed[index] > 0.001f) RabiMobileUi.secondary else RabiMobileUi.accentSurface
            paint.alpha = (55+200*edge*edge).toInt()
            canvas.drawRoundRect(x,center-half,x+stride*0.48f,center+half,2*density,2*density,paint)
        }
        paint.alpha = 255
        if(live && EventSplitSettings.showTranscribeLine(context)) {
            val y = center-threshold/scale*(height-12*density).coerceAtLeast(1f)/2
            paint.color = RabiMobileUi.warning; paint.alpha = 115; paint.strokeWidth = density
            paint.pathEffect = DashPathEffect(floatArrayOf(6*density,4*density),0f)
            canvas.drawLine(inset,y,width-inset,y,paint); paint.pathEffect = null; paint.alpha = 255
        }
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if(compact) { drawCompact(canvas); return }
        val density = resources.displayMetrics.density
        val inset = 16 * density; val top = 42 * density; val bottom = height - 18 * density
        val chartWidth = width - inset * 2; val chartHeight = (bottom - top).coerceAtLeast(1f)
        canvas.drawColor(RabiMobileUi.surface)
        paint.color = RabiMobileUi.secondary; paint.textSize = 12 * resources.displayMetrics.scaledDensity
        canvas.drawText(state,inset,24*density,paint)
        val peak = levels.maxOrNull() ?: 0f
        val text = String.format(Locale.ROOT,"峰值 %.4f",peak)
        canvas.drawText(text,width-inset-paint.measureText(text),24*density,paint)
        paint.color = Color.argb(32,128,128,128); paint.strokeWidth = density
        for(line in 1..3) { val y = top + chartHeight * line/4; canvas.drawLine(inset,y,width-inset,y,paint) }
        val threshold = EventSplitSettings.load(context).signalThreshold.toFloat()
        val scale = maxOf(0.04f,peak,threshold) * 1.15f
        val stride = chartWidth/120
        levels.takeLast(120).forEachIndexed { index, value ->
            if(value > 0 || live) {
                val x = inset + (120 - minOf(120,levels.size) + index) * stride
                val barHeight = maxOf(2*density, value/scale*chartHeight)
                paint.color = if(value == 0f) Color.argb(65,128,128,128) else if((live && value >= threshold) || (!live && index/120f <= progress)) Color.rgb(38,152,100) else Color.rgb(24,165,167)
                canvas.drawRoundRect(x,bottom-barHeight,x+stride*0.625f,bottom,density,density,paint)
            }
        }
        // Historical waveforms aggregate whole events; current live thresholds do not apply to them.
        if(live && EventSplitSettings.showTranscribeLine(context)) {
            val y = bottom - threshold/scale*chartHeight
            paint.color = Color.rgb(201,155,72); paint.strokeWidth = 1.5f*density
            paint.pathEffect = DashPathEffect(floatArrayOf(7*density,5*density),0f)
            canvas.drawLine(inset,y,width-inset,y,paint)
            paint.pathEffect = null
            val caption = String.format(Locale.ROOT,"转写参考线 %.3f",threshold)
            paint.textSize = 11*resources.displayMetrics.scaledDensity
            val labelY = maxOf(top+paint.textSize,y-5*density)
            val labelWidth = paint.measureText(caption)
            paint.color = RabiMobileUi.surface
            canvas.drawRect(inset,labelY-paint.textSize,inset+labelWidth+4*density,labelY+2*density,paint)
            paint.color = Color.rgb(201,155,72)
            canvas.drawText(caption,inset,labelY,paint)
        }
        if(!live && levels.isNotEmpty()) {
            paint.color = RabiMobileUi.primary
            val x = inset + progress * chartWidth; canvas.drawLine(x,top,x,bottom,paint)
        }
        if(levels.isEmpty()) { paint.color = RabiMobileUi.secondary; canvas.drawText("正在读取声波…",inset,top+chartHeight/2,paint) }
    }
}
