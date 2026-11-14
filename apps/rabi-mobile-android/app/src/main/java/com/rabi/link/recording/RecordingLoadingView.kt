package com.rabi.link.recording

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import com.rabi.link.RabiMobileUi

/** Geometry only: placeholders never masquerade as saved records or transcription. */
internal class RecordingLoadingView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val row = height/4f
        paint.color = RabiMobileUi.border
        for(index in 0 until 4) {
            val top = index*row+12*density
            canvas.drawRoundRect(8*density,top,36*density,top+28*density,8*density,8*density,paint)
            canvas.drawRoundRect(50*density,top+2*density,width*.7f,top+10*density,4*density,4*density,paint)
            canvas.drawRoundRect(50*density,top+18*density,width*.5f,top+24*density,3*density,3*density,paint)
        }
    }
}
