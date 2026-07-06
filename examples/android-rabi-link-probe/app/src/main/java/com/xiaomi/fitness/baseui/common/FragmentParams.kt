package com.xiaomi.fitness.baseui.common

import android.os.Bundle
import android.os.Parcel
import android.os.Parcelable
import java.io.Serializable

class FragmentParams(
    private val className: String?,
    private val bundle: Bundle?,
    private val backAble: Boolean,
    private val isResizeMode: Boolean
) : Parcelable, Serializable {
    private constructor(parcel: Parcel) : this(
        className = null,
        bundle = null,
        backAble = false,
        isResizeMode = false
    )

    fun getClassName(): String? = className
    fun getBundle(): Bundle? = bundle
    fun isBackAble(): Boolean = backAble
    fun isResizeMode(): Boolean = isResizeMode

    override fun describeContents(): Int = 0

    override fun writeToParcel(parcel: Parcel, flags: Int) {
        parcel.writeByte(if (backAble) 1 else 0)
        parcel.writeBundle(bundle)
        parcel.writeString(className)
        parcel.writeByte(if (isResizeMode) 1 else 0)
    }

    companion object CREATOR : Parcelable.Creator<FragmentParams> {
        override fun createFromParcel(parcel: Parcel): FragmentParams = FragmentParams(parcel)
        override fun newArray(size: Int): Array<FragmentParams?> = arrayOfNulls(size)
    }
}
