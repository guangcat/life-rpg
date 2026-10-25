# 纯标准库生成图标,不依赖 PIL。带解析抗锯齿(用 SDF 距离做 1px 羽化)。
import zlib, struct, math, os

CATS = ['#4f8cff', '#37d6a0', '#b783ff', '#ff6b7a', '#ffa94d', '#5ec8ff']
BG   = '#0b0f17'
PANEL= '#141a26'
LINE = '#2b3a4d'
GOLD = '#ffcf5c'

def rgb(h):
    h = h.lstrip('#')
    return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16))

def write_png(path, w, h, buf):
    raw = b''.join(b'\x00' + bytes(buf[y*w*3:(y+1)*w*3]) for y in range(h))
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)

def sdrr(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r

def sdbox(px, py, cx, y0, y1, hw):
    dx = abs(px - cx) - hw
    dy = max(y0 - py, py - y1)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0)

def build(N):
    buf = bytearray(N*N*3)
    bg, pa, ln, gd = rgb(BG), rgb(PANEL), rgb(LINE), rgb(GOLD)
    cols = [rgb(c) for c in CATS]
    cx = cy = N/2.0

    # 面板几何
    phw, phh = N*0.40, N*0.28
    pcy = N*0.50
    # 六根柱子
    bw = N*0.036
    gap = N*0.072
    x0 = cx - gap*2.5
    bottom = pcy + phh*0.72
    hts = [0.62, 0.44, 0.52, 0.70, 0.36, 0.48]

    for y in range(N):
        py = y + 0.5
        for x in range(N):
            px = x + 0.5
            # 背景 + 顶部金色氛围光
            d = math.hypot((px-cx)*0.55, (py-N*0.10)*1.6)
            glow = max(0.0, 1.0 - d/(N*0.72)) ** 2.0 * 0.14
            r = bg[0]*(1-glow) + gd[0]*glow
            g = bg[1]*(1-glow) + gd[1]*glow
            b = bg[2]*(1-glow) + gd[2]*glow

            # 面板底
            a = min(1.0, max(0.0, 0.5 - sdrr(px,py,cx,pcy,phw,phh,N*0.055)))
            if a > 0:
                r += (pa[0]-r)*a; g += (pa[1]-g)*a; b += (pa[2]-b)*a
            # 面板描边
            a = min(1.0, max(0.0, 0.5 - abs(sdrr(px,py,cx,pcy,phw,phh,N*0.055)) + N*0.0016))
            if a > 0:
                r += (ln[0]-r)*a; g += (ln[1]-g)*a; b += (ln[2]-b)*a

            # 六根柱子(带圆头)
            for i in range(6):
                bx = x0 + i*gap
                top = bottom - hts[i]*phh*1.15
                c = cols[i]
                a = min(1.0, max(0.0, 0.5 - sdbox(px,py,bx,top+bw,bottom,bw)))
                a = max(a, min(1.0, max(0.0, 0.5 - (math.hypot(px-bx, py-top-bw) - bw))))
                if a > 0:
                    r += (c[0]-r)*a; g += (c[1]-g)*a; b += (c[2]-b)*a

            o = (y*N + x)*3
            buf[o]   = max(0, min(255, int(r+0.5)))
            buf[o+1] = max(0, min(255, int(g+0.5)))
            buf[o+2] = max(0, min(255, int(b+0.5)))
    return buf

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'icon-180.png')]:
    write_png(os.path.join(here, name), size, size, build(size))
    print('wrote', name, size)
