package com.rabi.link.recording

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import com.rabi.link.RabiMobileUi

/** Small device silhouettes use the app palette without shipping vendor product artwork. */
class DeviceGlyphView(context: Context, private val kind: String) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save(); canvas.scale(width / 40f,height / 40f)
        paint.color = RabiMobileUi.accentSurface; paint.style = Paint.Style.FILL
        canvas.drawRoundRect(0f,0f,40f,40f,10f,10f,paint)
        paint.color = RabiMobileUi.secondary; paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f
        paint.strokeCap = Paint.Cap.ROUND
        when(kind) {
            "phone" -> {
                canvas.drawRoundRect(11f,5f,29f,35f,3f,3f,paint)
                canvas.drawLine(17f,9f,23f,9f,paint); canvas.drawLine(18f,31f,22f,31f,paint)
            }
            "glasses" -> {
                canvas.drawRoundRect(4f,17f,17f,28f,4f,4f,paint); canvas.drawRoundRect(23f,17f,36f,28f,4f,4f,paint)
                canvas.drawLine(17f,20f,23f,20f,paint); canvas.drawLine(4f,20f,7f,12f,paint); canvas.drawLine(36f,20f,33f,12f,paint)
            }
            "watch" -> {
                canvas.drawRoundRect(10f,11f,30f,29f,5f,5f,paint)
                canvas.drawLine(15f,10f,16f,4f,paint); canvas.drawLine(25f,10f,24f,4f,paint)
                canvas.drawLine(15f,30f,16f,36f,paint); canvas.drawLine(25f,30f,24f,36f,paint)
                canvas.drawLine(20f,15f,20f,21f,paint); canvas.drawLine(20f,21f,24f,23f,paint)
            }
            else -> {
                canvas.drawRoundRect(5f,8f,35f,28f,2f,2f,paint)
                canvas.drawLine(20f,28f,20f,34f,paint); canvas.drawLine(13f,34f,27f,34f,paint)
            }
        }
        canvas.restore()
    }
}
