"""CamScanner-style receipt scan: find the paper's four corners, flatten it to an
exact rectangle, then even out the lighting so the paper is white and the ink
keeps its colour. Executed by the private scan runtime (OpenCV, NumPy, Pillow).

CLI (unchanged): chopper_scan.py SOURCE DEST CORNERS_JSON [manual|auto]
CORNERS_JSON are the reader's normalised TL,TR,BR,BL corners: the fallback when
the paper cannot be found in the pixels, or the exact corners when 'manual'.
"""
import json, math, sys
import cv2
import numpy as np
from PIL import Image, ImageOps

WORK = 900  # detection width in pixels
SCANNER = 'camscan-2'  # stamped on every scan; Chopper re-scans stashed receipts made by older versions


def paper_mask(rgb):
    """Bright, low-saturation pixels: receipt paper (and anything else white)."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    v = cv2.GaussianBlur(hsv[:, :, 2], (5, 5), 0)
    s = hsv[:, :, 1]
    level, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = ((v > max(level, 110)) & (s < 70)).astype(np.uint8) * 255
    # Close over printed text so a line of ink doesn't break the paper apart.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))


def lenient_mask(rgb):
    """LENIENT_MASK_V1: paper = low colour saturation at any brightness above dim, so a receipt
    half in shadow stays whole. Used only as a retry when the normal crop lost the total."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    v = cv2.GaussianBlur(hsv[:, :, 2], (5, 5), 0)
    s = cv2.GaussianBlur(hsv[:, :, 1], (5, 5), 0)
    mask = ((v > 90) & (s < 45)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))


def robust_line(ys, xs):
    """x = a*y + b, ignoring fingers, clips and shadows that bite into an edge."""
    ys, xs = np.asarray(ys, float), np.asarray(xs, float)
    keep = np.ones(len(ys), bool)
    for _ in range(4):
        if keep.sum() < 10:
            break
        a, b = np.polyfit(ys[keep], xs[keep], 1)
        residual = np.abs(xs - (a * ys + b))
        limit = max(2.0, 2.5 * np.median(residual[keep]))
        keep = residual <= limit
    return np.polyfit(ys[keep], xs[keep], 1)


def band_corners(mask):
    """A receipt is a long paper band through the middle of the photo. Measure it
    in the middle rows, then walk up and down row by row while the paper keeps the
    same width and its edges move smoothly; stop where that breaks (the keyboard it
    is tucked under, an object on top, the end of the paper). Fingers and clips that
    bite one edge are skipped for that edge only. Straight lines are then fitted
    through the left and right edges; top and bottom follow the paper's own edge."""
    h, w = mask.shape
    paper = mask > 0

    def run_at(y, x):
        """The paper run in row y that contains column x, as (left, right)."""
        row = paper[y]
        if not 0 <= x < w or not row[x]:
            return None
        left = x
        while left > 0 and row[left - 1]:
            left -= 1
        right = x
        while right < w - 1 and row[right + 1]:
            right += 1
        return left, right

    middle = []
    for y in range(int(h * 0.4), int(h * 0.6)):
        r = run_at(y, w // 2)
        if r and w * 0.12 < r[1] - r[0] < w * 0.92:
            middle.append(r)
    if len(middle) < h * 0.05:
        return None
    left0 = float(np.median([r[0] for r in middle]))
    right0 = float(np.median([r[1] for r in middle]))
    width0 = right0 - left0
    jump, patience = w * 0.035, max(4, int(h * 0.012))
    lefts, rights, ends = {}, {}, {}
    for step in (-1, 1):
        prev_l, prev_r, misses, last_good = left0, right0, 0, h // 2
        y = h // 2
        while 0 <= y + step < h:
            y += step
            r = run_at(y, int((prev_l + prev_r) / 2))
            ok_l = ok_r = False
            if r:
                ok_l = abs(r[0] - prev_l) <= jump
                ok_r = abs(r[1] - prev_r) <= jump
                width = r[1] - r[0]
                if width > width0 * 1.3:      # widens suddenly: ran into the keyboard/desk
                    ok_l = ok_r = False
                elif width < width0 * 0.7:    # narrows: something covers part of an edge
                    ok_l = ok_l and abs(r[0] - prev_l) <= 2
                    ok_r = ok_r and abs(r[1] - prev_r) <= 2
            if ok_l:
                lefts[y] = r[0]; prev_l = r[0]
            if ok_r:
                rights[y] = r[1]; prev_r = r[1]
            if ok_l and ok_r:
                misses, last_good = 0, y
            else:
                misses += 1
                if misses > patience:
                    break
        ends[step] = last_good
    top, bottom = ends[-1], ends[1]
    if bottom - top < h * 0.3 or len(lefts) < 20 or len(rights) < 20:
        return None
    trim = lambda d: {y: x for y, x in d.items() if top + (bottom - top) * 0.03 <= y <= bottom - (bottom - top) * 0.03}
    lefts, rights = trim(lefts), trim(rights)
    left = robust_line(list(lefts), list(lefts.values()))
    right = robust_line(list(rights), list(rights.values()))

    def edge(at_top):
        """Fit the top/bottom paper edge across the columns; flat when it can't be seen."""
        y0 = top if at_top else bottom
        lx, rx = np.polyval(left, y0), np.polyval(right, y0)
        xs, ys = [], []
        for x in np.linspace(lx + (rx - lx) * 0.15, rx - (rx - lx) * 0.15, 25).astype(int):
            if not 0 <= x < w:
                continue
            y, moved, step = int(y0), 0, -1 if at_top else 1
            reach = int(h * 0.04)
            # walk outwards from inside the paper to its edge
            y = int(y0 - step * reach)
            y = min(max(y, 0), h - 1)
            while 0 <= y + step < h and paper[y + step, x] and moved < 2 * reach:
                y += step; moved += 1
            if moved < 2 * reach:
                xs.append(x); ys.append(y)
        # The paper's top/bottom edge is square to its sides; anything else is an
        # object lying across it (a clip, a pen, a finger), so fall back to square.
        square = -(left[0] + right[0]) / 2
        centre = (lx + rx) / 2
        if len(xs) >= 8:
            slope, cut = np.polyfit(xs, ys, 1)
            residual = np.abs(np.array(ys) - (slope * np.array(xs) + cut))
            if abs(slope - square) < 0.04 and np.median(residual) < h * 0.006:
                return slope, cut
            y0 = float(np.median(ys)) if at_top else y0
        return square, y0 - square * centre

    def meet(side, line):
        a, b = side          # x = a*y + b
        m, c = line          # y = m*x + c
        y = (m * b + c) / (1 - m * a)
        return [a * y + b, y]

    t, btm = edge(True), edge(False)
    corners = [meet(left, t), meet(right, t), meet(right, btm), meet(left, btm)]
    return [[min(max(x / (w - 1), 0.0), 1.0), min(max(y / (h - 1), 0.0), 1.0)] for x, y in corners]


def quad_corners(mask):
    """Fallback for a receipt that isn't a long band: the biggest four-sided paper shape."""
    h, w = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        hull = cv2.convexHull(contour)
        for factor in (0.02, 0.03, 0.05):
            poly = cv2.approxPolyDP(hull, factor * cv2.arcLength(hull, True), True)
            area = cv2.contourArea(poly) / (w * h)
            if len(poly) == 4 and 0.08 < area < 0.95:
                p = poly.reshape(4, 2).astype(float)
                order = [p[np.argmin(p.sum(1))], p[np.argmin(np.diff(p, axis=1).ravel())],
                         p[np.argmax(p.sum(1))], p[np.argmax(np.diff(p, axis=1).ravel())]]
                return [[x / (w - 1), y / (h - 1)] for x, y in order]
    return None


def detect(rgb, lenient=False):
    h, w = rgb.shape[:2]
    scale = WORK / w
    small = cv2.resize(rgb, (WORK, round(h * scale)), interpolation=cv2.INTER_AREA)
    mask = lenient_mask(small) if lenient else paper_mask(small)
    return band_corners(mask) or quad_corners(mask)


def enhance(rgb):
    """'Magic colour': divide out uneven lighting and creases, neutral white paper,
    ink keeps its colour, near-white becomes clean white."""
    img = rgb.astype(np.float32)
    k = max(15, (min(rgb.shape[:2]) // 40) | 1)
    background = cv2.dilate(rgb, np.ones((k, k), np.uint8))  # text removed -> paper + lighting
    background = cv2.GaussianBlur(background, (0, 0), k / 3).astype(np.float32)
    flat = np.clip(img / np.maximum(background, 1) * 255, 0, 255)
    # Neutral paper: scale each channel so the paper (the bright majority) is white.
    gray = flat.mean(axis=2)
    paper = gray > np.percentile(gray, 40)
    if paper.any():
        flat = np.clip(flat * (250 / np.maximum(flat[paper].mean(axis=0), 1)), 0, 255)
    gray = flat.mean(axis=2)
    black = float(np.percentile(gray, 1.0))
    out = np.clip((flat - black) * 255 / max(235 - black, 1), 0, 255)
    out = 255 * (out / 255) ** 1.2   # a touch darker ink
    out[out.mean(axis=2) > 225] = 255  # clean paper
    out = out.astype(np.uint8)
    blur = cv2.GaussianBlur(out, (0, 0), 1.0)
    return cv2.addWeighted(out, 1.4, blur, -0.4, 0)


def trim_dark_edges(img):
    """Shave off a shadow line or sliver of desk left along the paper's outer edge:
    cut past the last dark row/column within the outer 3% of each side."""
    gray = img.mean(axis=2)
    h, w = gray.shape
    band_h, band_w = max(1, int(h * 0.03)), max(1, int(w * 0.03))
    rows, cols = gray.mean(axis=1), gray.mean(axis=0)
    dark = lambda values: [i for i, v in enumerate(values) if v < 200]
    top = max(dark(rows[:band_h]), default=-1) + 1
    bottom = h - (max(dark(rows[::-1][:band_h]), default=-1) + 1)
    left = max(dark(cols[:band_w]), default=-1) + 1
    right = w - (max(dark(cols[::-1][:band_w]), default=-1) + 1)
    return img[top:bottom, left:right]


def scan(source, destination, corners, manual=False, lenient=False):
    image = ImageOps.exif_transpose(Image.open(source)).convert('RGB')
    if image.width * image.height > 40_000_000:
        raise ValueError('Image too large')
    rgb = np.array(image)
    h, w = rgb.shape[:2]
    detected = None if manual else detect(rgb, lenient)
    if detected:
        corners = detected
    if len(corners) != 4 or any(not 0 <= n <= 1 for p in corners for n in p):
        raise ValueError('Four normalised paper corners required')
    points = np.array([[p[0] * (w - 1), p[1] * (h - 1)] for p in corners], np.float32)
    # Pull in a hair so no desk shows along the paper edge.
    centre = points.mean(0)
    points = centre + (points - centre) * 0.992
    area = cv2.contourArea(points)
    if area < w * h * 0.02:
        raise ValueError('Crop too small')
    width = (np.linalg.norm(points[1] - points[0]) + np.linalg.norm(points[2] - points[3])) / 2
    height = (np.linalg.norm(points[3] - points[0]) + np.linalg.norm(points[2] - points[1])) / 2
    scale = min(1.0, 1400 / width, 6000 / height)
    width, height = max(2, round(width * scale)), max(2, round(height * scale))
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], np.float32)
    flat = cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(points, target), (width, height),
                               flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    Image.fromarray(trim_dark_edges(enhance(flat))).save(destination, 'JPEG', quality=92, subsampling=0)
    # What the person should hear about straight away.
    warnings = []
    if not detected:
        warnings.append('edges')
    else:
        sides = {'top': min(p[1] for p in corners[:2]) <= 0.003, 'bottom': max(p[1] for p in corners[2:]) >= 0.997,
                 'left': min(corners[0][0], corners[3][0]) <= 0.003, 'right': max(corners[1][0], corners[2][0]) >= 0.997}
        warnings += ['off-photo:' + side for side, off in sides.items() if off]
    print(json.dumps({'scanner': SCANNER, 'corners': [[float(x), float(y)] for x, y in corners], 'edgeDetection': bool(detected),
                      'warnings': warnings, 'width': width, 'height': height}))


if __name__ == '__main__':
    mode = sys.argv[4] if len(sys.argv) > 4 else 'auto'
    scan(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), mode == 'manual', mode == 'lenient')
