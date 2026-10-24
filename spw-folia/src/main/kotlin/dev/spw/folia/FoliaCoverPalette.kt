package dev.spw.folia

import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.util.Base64
import javax.imageio.ImageIO

/**
 * v0.4.0: derives the intro-curtain palette from the current song cover.
 *
 * The cover arrives from the host as a `data:image/…;base64,…` URL (see
 * [FoliaPlaybackExtension.coverDataUrlForPalette]). It is decoded, downscaled to a tiny thumbnail and
 * reduced to a handful of vivid accent colours: hue buckets weighted by pixel count and saturation,
 * then picked with a minimum hue distance so the animation does not end up with four near-identical
 * blues. Values are normalised (medium-high saturation / brightness) because the native curtain uses
 * them both for soft glows and for the gradient wordmark; it darkens them again for the background.
 *
 * Everything here is best-effort: a missing / broken / grey cover falls back to [FALLBACK], so the
 * animation never depends on the artwork being readable.
 */
internal object FoliaCoverPalette {

    /** Used when there is no cover yet, the bytes are unreadable, or the cover is essentially grey. */
    val FALLBACK: List<String> = listOf("#8A63FF", "#FF5CA8", "#49D8FF", "#FFC66B")

    /** Below this many distinguishable colours the cover is treated as grey and the fallback is used. */
    private const val MIN_DISTINCT = 2

    private const val THUMB = 28

    /**
     * Returns up to four `#RRGGBB` colours for [dataUrl] (or [FALLBACK] when unavailable). Never
     * throws: the curtain must always get a usable palette.
     */
    fun paletteFromDataUrl(dataUrl: String?): List<String> {
        val image = decodeImage(dataUrl) ?: return FALLBACK
        return try {
            val picked = extract(image)
            if (picked.size < MIN_DISTINCT) FALLBACK else fill(picked)
        } catch (t: Throwable) {
            FoliaPlugin.logStatic("cover palette failed: ${t::class.java.name}: ${t.message}")
            FALLBACK
        }
    }

    // ------------------------------------------------------------------- decode ----

    private fun decodeImage(dataUrl: String?): BufferedImage? {
        if (dataUrl.isNullOrBlank()) return null
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        val meta = dataUrl.substring(0, comma)
        if (!meta.contains(";base64", ignoreCase = true)) return null
        if (!meta.startsWith("data:image", ignoreCase = true)) return null
        val bytes = try {
            Base64.getDecoder().decode(dataUrl.substring(comma + 1))
        } catch (t: Throwable) {
            FoliaPlugin.logStatic("cover palette: base64 decode failed: ${t.message}")
            return null
        }
        return try {
            ImageIO.read(ByteArrayInputStream(bytes))
        } catch (t: Throwable) {
            FoliaPlugin.logStatic("cover palette: image decode failed: ${t::class.java.name}: ${t.message}")
            null
        }
    }

    // ------------------------------------------------------------------- extract ----

    private class Bucket(val hue: Double, val saturation: Double, val value: Double) {
        var count: Int = 0
        var sumR: Double = 0.0
        var sumG: Double = 0.0
        var sumB: Double = 0.0
        var weight: Double = 0.0

        fun average(): Triple<Int, Int, Int> {
            if (count == 0) return Triple(0, 0, 0)
            return Triple(
                (sumR / count).toInt().coerceIn(0, 255),
                (sumG / count).toInt().coerceIn(0, 255),
                (sumB / count).toInt().coerceIn(0, 255)
            )
        }
    }

    private fun extract(source: BufferedImage): List<String> {
        val thumb = BufferedImage(THUMB, THUMB, BufferedImage.TYPE_INT_ARGB)
        val g = thumb.createGraphics()
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
            g.drawImage(source, 0, 0, THUMB, THUMB, null)
        } finally {
            g.dispose()
        }

        // 16 hue buckets × light/dark split, so dark and bright regions of the cover both survive.
        val buckets = HashMap<String, Bucket>()
        for (y in 0 until THUMB) {
            for (x in 0 until THUMB) {
                val argb = thumb.getRGB(x, y)
                val a = (argb ushr 24) and 0xFF
                if (a < 128) continue
                val r = (argb ushr 16) and 0xFF
                val gg = (argb ushr 8) and 0xFF
                val b = argb and 0xFF
                val (hue, sat, value) = hsv(r, gg, b)
                // Skip almost-black pixels and near-white pixels: they carry no accent.
                if (value < 0.10) continue
                if (sat < 0.06 && value > 0.92) continue
                val hueBucket = if (sat < 0.10) -1 else ((hue / 22.5).toInt()) % 16
                val shade = if (value < 0.55) 'd' else 'l'
                val key = "$hueBucket$shade"
                val bucket = buckets.getOrPut(key) { Bucket(hue, sat, value) }
                bucket.count += 1
                bucket.sumR += r.toDouble()
                bucket.sumG += gg.toDouble()
                bucket.sumB += b.toDouble()
                bucket.weight += (0.35 + 0.65 * sat) * (0.55 + 0.45 * value)
            }
        }

        val ranked = buckets.values
            .filter { it.count >= 6 }
            .sortedByDescending { it.weight }

        val picked = ArrayList<Bucket>(4)
        // First pass: keep the hues apart so a mostly-blue cover still yields a usable gradient.
        for (candidate in ranked) {
            if (picked.size >= 4) break
            if (picked.none { hueDistance(it.hue, candidate.hue) >= 28.0 }) picked.add(candidate)
        }
        // Second pass: fill the remaining slots with the strongest leftovers.
        for (candidate in ranked) {
            if (picked.size >= 4) break
            if (picked.none { it === candidate }) picked.add(candidate)
        }

        return picked.map { bucket ->
            val (r, gg, b) = bucket.average()
            val (hue, sat, value) = hsv(r, gg, b)
            // Normalise for glow/text use: brighten dull pixels, keep a little of the original drama.
            val finalSat = sat.coerceIn(0.42, 0.95)
            val finalValue = value.coerceIn(0.58, 0.97)
            toHex(hsvToRgb(hue, finalSat, finalValue))
        }
    }

    private fun fill(picked: List<String>): List<String> {
        if (picked.isEmpty()) return FALLBACK
        val out = ArrayList<String>(4)
        out.addAll(picked)
        for (color in FALLBACK) {
            if (out.size >= 4) break
            out.add(color)
        }
        return out
    }

    // ------------------------------------------------------------------- colour ----

    private fun hueDistance(a: Double, b: Double): Double {
        val d = Math.abs(a - b) % 360.0
        return if (d > 180.0) 360.0 - d else d
    }

    private fun hsv(r: Int, g: Int, b: Int): Triple<Double, Double, Double> {
        val rn = r / 255.0
        val gn = g / 255.0
        val bn = b / 255.0
        val max = maxOf(rn, gn, bn)
        val min = minOf(rn, gn, bn)
        val delta = max - min
        var hue = 0.0
        if (delta > 1e-6) {
            hue = when (max) {
                rn -> 60.0 * (((gn - bn) / delta) % 6.0)
                gn -> 60.0 * (((bn - rn) / delta) + 2.0)
                else -> 60.0 * (((rn - gn) / delta) + 4.0)
            }
        }
        if (hue < 0.0) hue += 360.0
        val sat = if (max <= 1e-6) 0.0 else delta / max
        return Triple(hue, sat, max)
    }

    private fun hsvToRgb(hue: Double, saturation: Double, value: Double): Triple<Int, Int, Int> {
        val h = ((hue % 360.0) + 360.0) % 360.0
        val c = value * saturation
        val x = c * (1.0 - Math.abs((h / 60.0) % 2.0 - 1.0))
        val m = value - c
        val (r1, g1, b1) = when {
            h < 60.0 -> Triple(c, x, 0.0)
            h < 120.0 -> Triple(x, c, 0.0)
            h < 180.0 -> Triple(0.0, c, x)
            h < 240.0 -> Triple(0.0, x, c)
            h < 300.0 -> Triple(x, 0.0, c)
            else -> Triple(c, 0.0, x)
        }
        fun toByte(v: Double): Int = ((v + m) * 255.0).roundToIntSafe()
        return Triple(toByte(r1), toByte(g1), toByte(b1))
    }

    private fun Double.roundToIntSafe(): Int = Math.round(this).toInt().coerceIn(0, 255)

    private fun toHex(rgb: Triple<Int, Int, Int>): String {
        val (r, g, b) = rgb
        return String.format("#%02X%02X%02X", r, g, b)
    }
}
