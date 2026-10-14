package com.n5.minismanager

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ViewConfiguration
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlin.math.abs

/**
 * Pull-to-refresh that leaves sideways swipes alone: the page has rows that scroll left/right
 * (Continue watching, Next up…) and the stock layout grabbed any slightly diagonal drag.
 * A gesture that starts horizontally is handed to the page for the rest of that touch.
 * The page can also hold the refresh off while a finger is inside a scrollable row (see Bridge.holdRefresh).
 */
class PullToRefresh @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : SwipeRefreshLayout(context, attrs) {
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var declined = false
    /** Set from the page while a touch is inside a horizontally scrollable element. */
    @Volatile var held = false

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                declined = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (declined || held) return false
                val dx = abs(ev.x - downX)
                val dy = abs(ev.y - downY)
                if (dx > slop && dx > dy) {
                    declined = true
                    return false
                }
                // Not yet clearly vertical: don't let the stock logic start the spinner.
                if (dy <= slop * 2 || dy < dx * 2) return false
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> declined = false
        }
        if (declined || held) return false
        return super.onInterceptTouchEvent(ev)
    }
}
