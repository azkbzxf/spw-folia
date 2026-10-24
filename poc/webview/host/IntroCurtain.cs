// spw-folia-host.exe intro curtain (v0.4.0).
//
// Why this exists: the player window opens straight into the page's first paint (and, for a
// persisted transparent + mouse-passthrough session, into the colour-key hand-over). Both used to
// show a raw un-keyed magenta / black frame for a moment. The host now drives the layered colour key
// natively (HostForm.cs, ApplyTransparencyVisual) and this veil covers the whole open transition.
//
// v0.4.0 design (user request): the veil is shown for every Folia open, tinted from the current song
// cover (FoliaCoverPalette → `--curtain-palette`), fades in from fully transparent to opaque over a
// user-configurable 0.3-2.0 s (`--curtain-duration`), and only then lifts to reveal the page.
// It draws a deep cover-tinted gradient, soft aurora glows, drifting embers, a light sweep, the
// `Folia` wordmark and the second line `让歌词成为风景` painted left-to-right with a cover palette
// gradient.
//
// C# 5 only (in-box .NET Framework 4.8 csc.exe): no interpolation / ?. / expression bodies.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SpwFolia
{
    internal sealed class IntroCurtain : Form
    {
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const uint LWA_ALPHA = 0x00000002;
        private const int RevealMs = 620;
        private const int SparkCount = 46;
        private const int MinFadeInMs = 300;
        private const int MaxFadeInMs = 2000;

        private static readonly Color[] FallbackPalette = new Color[]
        {
            Color.FromArgb(255, 0x8A, 0x63, 0xFF),
            Color.FromArgb(255, 0xFF, 0x5C, 0xA8),
            Color.FromArgb(255, 0x49, 0xD8, 0xFF),
            Color.FromArgb(255, 0xFF, 0xC6, 0x6B),
        };

        [DllImport("user32.dll")]
        private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, int crKey, byte bAlpha, uint dwFlags);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;

        /// <summary>HWND_TOPMOST (-1): places the veil above every other topmost window.</summary>
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        private readonly Stopwatch clock = new Stopwatch();
        private readonly Timer anim = new Timer();
        private readonly Random rng = new Random(20261024);
        private readonly float[] sparkX = new float[SparkCount];
        private readonly float[] sparkY = new float[SparkCount];
        private readonly float[] sparkDrift = new float[SparkCount];
        private readonly float[] sparkPhase = new float[SparkCount];
        private readonly float[] sparkRadius = new float[SparkCount];
        private Bitmap scene;
        private bool fading;
        private long fadeStartMs;
        private bool finished;
        private int lastAlpha = -1;

        /// <summary>Per-monitor DPI scale (1.0 = 96 dpi), used for fixed-size details.</summary>
        private readonly float scale;

        /// <summary>Cover-derived accent colours (1-4). Never empty.</summary>
        private readonly Color[] palette;

        /// <summary>Fade-in duration, 300-2000 ms, from the 配置 page.</summary>
        private readonly int fadeInMs;

        /// <summary>Invoked on the UI thread once the veil has fully faded out.</summary>
        public Action Finished;

        public IntroCurtain(Rectangle bounds, float dpiScale, Color[] coverPalette, int fadeInMsMs)
        {
            float s = dpiScale > 0.1f ? dpiScale : 1f;
            if (s < 1f) s = 1f;
            if (s > 4f) s = 4f;
            scale = s;

            int fade = fadeInMsMs;
            if (fade < MinFadeInMs) fade = MinFadeInMs;
            if (fade > MaxFadeInMs) fade = MaxFadeInMs;
            fadeInMs = fade;

            palette = NormalizePalette(coverPalette);

            // The host form is created with AutoScaleMode.None for the same reason: a WinForms font
            // autoscale would resize this borderless full-monitor form when the DPI differs from the
            // primary monitor, and the veil would cover only part of the screen on a secondary one.
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            BackColor = Color.Black;
            ShowInTaskbar = false;
            TopMost = true;
            DoubleBuffered = true;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer, true);

            for (int i = 0; i < SparkCount; i++)
            {
                sparkX[i] = (float)rng.NextDouble();
                sparkY[i] = (float)rng.NextDouble();
                sparkDrift[i] = 0.6f + (float)rng.NextDouble() * 1.9f;
                sparkPhase[i] = (float)rng.NextDouble() * 6.283f;
                sparkRadius[i] = (1.6f + (float)rng.NextDouble() * 2.4f) * scale;
            }

            anim.Interval = 33;
            anim.Tick += OnAnimTick;
            RenderScene();
        }

        private static Color[] NormalizePalette(Color[] source)
        {
            if (source == null || source.Length == 0) return FallbackPalette;
            // Deduplicate and pad to four entries so gradients always have enough stops.
            Color[] out4 = new Color[4];
            int used = 0;
            for (int i = 0; i < source.Length && used < 4; i++)
            {
                Color c = source[i];
                if (c.A < 16) continue;
                bool duplicate = false;
                for (int j = 0; j < used; j++)
                {
                    if (out4[j].ToArgb() == c.ToArgb()) { duplicate = true; break; }
                }
                if (duplicate) continue;
                out4[used] = Color.FromArgb(255, c.R, c.G, c.B);
                used++;
            }
            if (used == 0) return FallbackPalette;
            for (int i = used; i < 4; i++) out4[i] = FallbackPalette[i % FallbackPalette.Length];
            return out4;
        }

        public bool IsFinished
        {
            get { return finished; }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // The veil starts fully transparent and fades up (user request: 从透明到不透明).
            TrySetAlpha(0);
        }

        /// <summary>
        /// v0.4.0: keeps the veil above the player window. Both forms are topmost; when the player is
        /// opaque (no transparency) it is shown after the veil and would fully cover it, which is why
        /// the opening animation used to be visible only in transparent sessions. Pushing the veil to
        /// the top of the topmost band makes it cover the player for every mode.
        /// </summary>
        internal void RaiseAbove()
        {
            try
            {
                if (IsDisposed || !IsHandleCreated) return;
                TopMost = true;
                SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                BringToFront();
            }
            catch (Exception) { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            clock.Start();
            anim.Start();
        }

        /// <summary>Start the fade-out; the veil hides itself once the fade completes.</summary>
        public void BeginReveal()
        {
            if (fading || finished) return;
            fading = true;
            fadeStartMs = clock.ElapsedMilliseconds;
        }

        private void OnAnimTick(object sender, EventArgs e)
        {
            if (finished) return;
            long now = clock.ElapsedMilliseconds;
            int alpha;
            if (fading)
            {
                float p = (now - fadeStartMs) / (float)RevealMs;
                if (p >= 1f)
                {
                    Finish();
                    return;
                }
                alpha = (int)(255f * (1f - Smooth(p)));
            }
            else
            {
                float p = now / (float)fadeInMs;
                if (p > 1f) p = 1f;
                alpha = (int)(255f * Smooth(p));
            }
            TrySetAlpha(alpha);
            Invalidate();
        }

        private void Finish()
        {
            if (finished) return;
            finished = true;
            anim.Stop();
            clock.Stop();
            TrySetAlpha(0);
            Hide();
            Action callback = Finished;
            if (callback != null)
            {
                try { callback(); } catch (Exception) { }
            }
        }

        private void TrySetAlpha(int alpha)
        {
            if (!IsHandleCreated) return;
            if (alpha < 0) alpha = 0;
            if (alpha > 255) alpha = 255;
            if (alpha == lastAlpha) return;
            lastAlpha = alpha;
            try { SetLayeredWindowAttributes(Handle, 0, (byte)alpha, LWA_ALPHA); }
            catch (Exception) { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                int w = ClientSize.Width;
                int h = ClientSize.Height;
                if (w <= 0 || h <= 0) return;
                if (scene != null) g.DrawImage(scene, 0, 0, w, h);
                double t = clock.Elapsed.TotalSeconds;
                DrawSweep(g, t, w, h);
                DrawSparks(g, t, w, h);
            }
            catch (Exception) { }
        }

        // ---------------------------------------------------------------- scene (rendered once)

        private void RenderScene()
        {
            try
            {
                int w = Math.Max(320, ClientSize.Width);
                int h = Math.Max(240, ClientSize.Height);
                Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

                    Rectangle full = new Rectangle(0, 0, w, h);
                    // Deep, dark background that still carries the cover's hue: the palette is mixed
                    // down towards near-black (0.10-0.26) so the veil reads as a night sky lit by the
                    // artwork, not as a flat colour wash.
                    using (LinearGradientBrush baseBrush = new LinearGradientBrush(full,
                        Darken(palette[0], 0.10f), Darken(palette[2], 0.10f), 90f))
                    {
                        ColorBlend blend = new ColorBlend(4);
                        blend.Colors = new Color[]
                        {
                            Darken(palette[0], 0.10f),
                            Darken(palette[1], 0.20f),
                            Darken(palette[2], 0.26f),
                            Darken(palette[3], 0.09f),
                        };
                        blend.Positions = new float[] { 0f, 0.38f, 0.72f, 1f };
                        baseBrush.InterpolationColors = blend;
                        g.FillRectangle(baseBrush, full);
                    }

                    float unit = Math.Min(w, h);
                    DrawGlow(g, w * 0.36f, h * 0.46f, unit * 0.66f, WithAlpha(palette[0], 84));
                    DrawGlow(g, w * 0.67f, h * 0.60f, unit * 0.34f, WithAlpha(palette[1], 56));
                    DrawGlow(g, w * 0.51f, h * 0.32f, unit * 0.26f, WithAlpha(palette[2], 40));
                    DrawGlow(g, w * 0.18f, h * 0.74f, unit * 0.22f, WithAlpha(palette[3], 34));
                    DrawGlow(g, w * 0.86f, h * 0.80f, unit * 0.20f, WithAlpha(palette[2], 30));

                    // Film grain keeps the large gradient from banding on wide gamut displays.
                    int grainCount = (int)(2600f * scale);
                    for (int i = 0; i < grainCount; i++)
                    {
                        int x = rng.Next(w);
                        int y = rng.Next(h);
                        int a = 3 + rng.Next(9);
                        using (SolidBrush grain = new SolidBrush(Color.FromArgb(a, 255, 255, 255)))
                        {
                            g.FillRectangle(grain, x, y, 1, 1);
                        }
                    }

                    DrawWordmark(g, w, h);
                }
                scene = bmp;
            }
            catch (Exception) { }
        }

        private static void DrawGlow(Graphics g, float cx, float cy, float radius, Color color)
        {
            if (radius < 8f) return;
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddEllipse(cx - radius, cy - radius, radius * 2f, radius * 2f);
                using (PathGradientBrush brush = new PathGradientBrush(path))
                {
                    brush.CenterPoint = new PointF(cx, cy);
                    brush.CenterColor = color;
                    brush.SurroundColors = new Color[] { Color.FromArgb(0, color) };
                    g.FillEllipse(brush, cx - radius, cy - radius, radius * 2f, radius * 2f);
                }
            }
        }

        private void DrawWordmark(Graphics g, int w, int h)
        {
            // Proportional: 10.5 % of the smaller monitor side, clamped to a sane apparent range
            // that is expressed in device pixels (hence the DPI factor).
            float size = Math.Min(w, h) * 0.105f;
            float minSize = 48f * scale;
            float maxSize = 260f * scale;
            if (size < minSize) size = minSize;
            if (size > maxSize) size = maxSize;

            Font main = NewFont("Segoe UI Light", size, FontStyle.Regular);
            StringFormat centered = new StringFormat();
            centered.Alignment = StringAlignment.Center;
            centered.LineAlignment = StringAlignment.Center;

            float cx = w * 0.5f;
            float cy = h * 0.45f;
            RectangleF titleBox = new RectangleF(cx - w * 0.4f, cy - size * 0.85f, w * 0.8f, size * 1.7f);

            // Soft halo behind the glyphs, tinted by the cover (approximates a glow without a blur pass).
            using (SolidBrush halo = new SolidBrush(WithAlpha(palette[0], 52)))
            {
                float[] offsets = new float[] { -4f * scale, 0f, 4f * scale };
                for (int i = 0; i < offsets.Length; i++)
                {
                    g.DrawString("Folia", main, halo,
                        new RectangleF(titleBox.X + offsets[i], titleBox.Y, titleBox.Width, titleBox.Height), centered);
                    g.DrawString("Folia", main, halo,
                        new RectangleF(titleBox.X, titleBox.Y + offsets[i], titleBox.Width, titleBox.Height), centered);
                }
            }
            using (SolidBrush ink = new SolidBrush(Color.FromArgb(240, 248, 246, 255)))
            {
                g.DrawString("Folia", main, ink, titleBox, centered);
            }

            float ruleWidth = w * 0.075f;
            using (LinearGradientBrush hair = new LinearGradientBrush(
                new RectangleF(cx - ruleWidth, cy + size * 0.62f, ruleWidth * 2f, Math.Max(1f, 1.3f * scale)),
                WithAlpha(palette[0], 150), WithAlpha(palette[2], 150), 0f))
            {
                g.FillRectangle(hair, cx - ruleWidth, cy + size * 0.62f, ruleWidth * 2f,
                    Math.Max(1f, 1.3f * scale));
            }

            // v0.4.0: second line 让歌词成为风景, painted with a cover-palette gradient from left to right.
            DrawGradientSubtitle(g, cx, cy + size * 0.80f, w, size);
            main.Dispose();
            centered.Dispose();
        }

        private void DrawGradientSubtitle(Graphics g, float cx, float top, int w, float titleSize)
        {
            float size = Math.Max(15f * scale, titleSize * 0.145f);
            Font sub = NewFont("Microsoft YaHei UI", size, FontStyle.Regular);
            StringFormat centered = new StringFormat();
            centered.Alignment = StringAlignment.Center;
            centered.LineAlignment = StringAlignment.Center;
            RectangleF box = new RectangleF(cx - w * 0.4f, top, w * 0.8f, size * 2.0f);
            try
            {
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddString("让歌词成为风景", sub.FontFamily, (int)sub.Style, sub.Size, box, centered);
                    // The gradient must span the *glyphs*, not the whole centred text box: a blend
                    // across the wide box would look almost uniform on the short second line.
                    RectangleF ink = path.GetBounds();
                    if (ink.Width < 1f || ink.Height < 1f) return;
                    using (LinearGradientBrush brush = new LinearGradientBrush(ink,
                        Brighten(palette[0], 0.20f), Brighten(palette[2], 0.26f), 0f))
                    {
                        ColorBlend blend = new ColorBlend(4);
                        blend.Colors = new Color[]
                        {
                            Brighten(palette[0], 0.20f),
                            Brighten(palette[1], 0.24f),
                            Brighten(palette[2], 0.26f),
                            Brighten(palette[3], 0.22f),
                        };
                        blend.Positions = new float[] { 0f, 0.36f, 0.72f, 1f };
                        brush.InterpolationColors = blend;
                        g.FillPath(brush, path);
                    }
                }
            }
            catch (Exception) { }
            sub.Dispose();
            centered.Dispose();
        }

        private static Font NewFont(string family, float size, FontStyle style)
        {
            try { return new Font(family, size, style, GraphicsUnit.Pixel); }
            catch (Exception) { }
            try { return new Font("Segoe UI", size, style, GraphicsUnit.Pixel); }
            catch (Exception) { }
            try { return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Pixel); }
            catch (Exception) { }
            return new Font(FontFamily.GenericSansSerif, size, style, GraphicsUnit.Pixel);
        }

        // ---------------------------------------------------------------- palette helpers

        private static Color Darken(Color c, float factor)
        {
            return Color.FromArgb(255,
                (int)Math.Round(c.R * factor),
                (int)Math.Round(c.G * factor),
                (int)Math.Round(c.B * factor));
        }

        private static Color Brighten(Color c, float amount)
        {
            return Color.FromArgb(255,
                (int)Math.Round(c.R + (255 - c.R) * amount),
                (int)Math.Round(c.G + (255 - c.G) * amount),
                (int)Math.Round(c.B + (255 - c.B) * amount));
        }

        private static Color WithAlpha(Color c, int alpha)
        {
            if (alpha < 0) alpha = 0;
            if (alpha > 255) alpha = 255;
            return Color.FromArgb(alpha, c.R, c.G, c.B);
        }

        // ---------------------------------------------------------------- animation

        private void DrawSweep(Graphics g, double t, int w, int h)
        {
            float phase = (float)((t / 3.4) % 1.0);
            if (phase < 0f) phase += 1f;
            float bandWidth = w * 0.34f;
            float center = -bandWidth + (w + bandWidth * 2f) * phase;
            PointF p1 = new PointF(center - bandWidth * 0.5f, 0f);
            PointF p2 = new PointF(center + bandWidth * 0.5f, h);
            Color tint = Brighten(palette[2], 0.45f);
            using (LinearGradientBrush brush = new LinearGradientBrush(p1, p2, Color.Transparent, Color.Transparent))
            {
                ColorBlend blend = new ColorBlend(3);
                blend.Colors = new Color[]
                {
                    Color.FromArgb(0, tint.R, tint.G, tint.B),
                    Color.FromArgb(20, tint.R, tint.G, tint.B),
                    Color.FromArgb(0, tint.R, tint.G, tint.B),
                };
                blend.Positions = new float[] { 0f, 0.5f, 1f };
                brush.InterpolationColors = blend;
                g.FillRectangle(brush, 0, 0, w, h);
            }
        }

        private void DrawSparks(Graphics g, double t, int w, int h)
        {
            Color ember = Brighten(palette[3], 0.35f);
            for (int i = 0; i < SparkCount; i++)
            {
                // Embers drift upwards slowly and wrap at the top edge.
                float y = sparkY[i] - (float)(t * sparkDrift[i] * 0.035);
                y = y - (float)Math.Floor(y);
                float twinkle = 0.5f + 0.5f * (float)Math.Sin(t * 1.7 + sparkPhase[i]);
                int alpha = (int)(26 + 74 * twinkle);
                float px = sparkX[i] * w;
                float py = y * h;
                float r = sparkRadius[i];
                using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, ember.R, ember.G, ember.B)))
                {
                    g.FillEllipse(b, px - r * 0.5f, py - r * 0.5f, r, r);
                }
            }
        }

        private static float Smooth(float p)
        {
            if (p <= 0f) return 0f;
            if (p >= 1f) return 1f;
            return p * p * (3f - 2f * p);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { anim.Stop(); } catch (Exception) { }
                try { anim.Dispose(); } catch (Exception) { }
                try
                {
                    if (scene != null)
                    {
                        scene.Dispose();
                        scene = null;
                    }
                }
                catch (Exception) { }
            }
            base.Dispose(disposing);
        }
    }
}
