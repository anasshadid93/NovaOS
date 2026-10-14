package com.n5.minismanager

import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.android.material.card.MaterialCardView

/** Android 15 draws apps edge to edge: keep content clear of the status and navigation bars (and the keyboard). */
fun applySystemBarInsets(root: View) {
    val start = root.paddingTop
    val bottom = root.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
        v.updatePadding(left = bars.left, top = start + bars.top, right = bars.right, bottom = bottom + bars.bottom)
        // Consumed: otherwise the WebView gets the same insets and the page adds its own
        // safe-area padding on top of ours (a blank band under the status bar).
        WindowInsetsCompat.CONSUMED
    }
}

/** Cards stay readable on a TV or tablet: at most 520dp wide, centred. */
fun limitCardWidth(root: View) {
    root.post {
        val card = findCard(root) ?: return@post
        val max = (520 * root.resources.displayMetrics.density).toInt()
        val avail = (root.width - 48 * root.resources.displayMetrics.density).toInt()
        card.layoutParams = card.layoutParams.apply { width = minOf(max, avail) }
    }
}

private fun findCard(v: View): MaterialCardView? {
    if (v is MaterialCardView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findCard(v.getChildAt(i))?.let { return it }
    return null
}
