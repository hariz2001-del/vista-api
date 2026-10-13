"""Real-pixel colour perspective flattening; executed by private Pillow runtime."""
import json, math, sys
from PIL import Image, ImageOps, ImageFilter

def detect_paper(image):
    import cv2, numpy as np
    small=image.copy();small.thumbnail((1200,1600))
    rgb=np.array(small);gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    blur=cv2.GaussianBlur(gray,(5,5),0)
    _,mask=cv2.threshold(blur,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    skin=cv2.inRange(hsv,np.array([0,65,40]),np.array([18,255,255]))
    skin=cv2.bitwise_or(skin,cv2.inRange(hsv,np.array([155,35,40]),np.array([179,255,255])))
    mask[skin>0]=0
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((13,13),np.uint8))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    candidates=[]
    # A hand can join the paper contour. For a tall portrait receipt, use the
    # sustained paper column band to exclude short hand/keyboard protrusions.
    # Keep the entire band's bounds when a four-corner contour is ambiguous.
    if contours:
        biggest=max(contours,key=cv2.contourArea)
        component=np.zeros_like(mask);cv2.drawContours(component,[biggest],-1,255,-1)
        columns=np.where((component>0).sum(axis=0)>small.height*.38)[0]
        if len(columns)>small.width*.15:
            left=max(0,int(columns[0]-small.width*.018));right=min(small.width-1,int(columns[-1]+small.width*.018))
            ys,xs=np.where(component[:,left:right+1]>0)
            if len(ys):
                top=int(ys.min());bottom=int(ys.max())
                if (bottom-top)/(right-left)>1.7 and bottom-top>small.height*.45:
                    def side_band(lo,hi):
                        spans=[]
                        for y in range(int(top+(bottom-top)*lo),int(top+(bottom-top)*hi)):
                            x=np.where(component[y,left:right+1]>0)[0]
                            if len(x)>(right-left)*.5:spans.append((x[0]+left,x[-1]+left))
                        return (float(np.percentile([x[0] for x in spans],75)),float(np.percentile([x[1] for x in spans],80))) if spans else (left,right)
                    tl,tr=side_band(.06,.2);bl,br=side_band(.8,.97)
                    bl=min(tl,left+2) # occluding fingers must not narrow the bottom paper crop
                    return [[tl/(small.width-1),top/(small.height-1)],[tr/(small.width-1),top/(small.height-1)],[br/(small.width-1),bottom/(small.height-1)],[bl/(small.width-1),bottom/(small.height-1)]]
    for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:8]:
        hull=cv2.convexHull(contour);perimeter=cv2.arcLength(hull,True)
        for factor in (.015,.02,.03,.04,.05):
            polygon=cv2.approxPolyDP(hull,factor*perimeter,True)
            area=cv2.contourArea(polygon)/(small.width*small.height)
            if len(polygon)==4 and .08<area<.97 and not any(x<=1 or y<=1 or x>=small.width-2 or y>=small.height-2 for x,y in polygon.reshape(4,2)):
                p=polygon.reshape(4,2).astype(float)
                order=[p[np.argmin(p.sum(axis=1))],p[np.argmin(np.diff(p,axis=1))],p[np.argmax(p.sum(axis=1))],p[np.argmax(np.diff(p,axis=1))]]
                if len({tuple(x) for x in order})!=4:continue
                candidates.append((area,[[float(x/(small.width-1)),float(y/(small.height-1))] for x,y in order]));break
    return max(candidates,key=lambda x:x[0])[1] if candidates else None

def solve(a, b):
    rows = [list(x) + [y] for x, y in zip(a, b)]
    for i in range(8):
        pivot = max(range(i, 8), key=lambda j: abs(rows[j][i]))
        rows[i], rows[pivot] = rows[pivot], rows[i]
        if abs(rows[i][i]) < 1e-10: raise ValueError('Degenerate receipt corners')
        v = rows[i][i]; rows[i] = [x / v for x in rows[i]]
        for j in range(8):
            if j != i:
                v = rows[j][i]; rows[j] = [x - v*y for x,y in zip(rows[j],rows[i])]
    return [row[-1] for row in rows]

def scan(source, destination, corners, manual=False):
    image = ImageOps.exif_transpose(Image.open(source)).convert('RGB')
    if image.width * image.height > 40_000_000: raise ValueError('Image too large')
    detected=None if manual else detect_paper(image)
    if detected:corners=detected
    # Include a small paper-edge margin rather than clipping printed edges.
    cx=sum(p[0] for p in corners)/4;cy=sum(p[1] for p in corners)/4
    corners=[[max(0,min(1,cx+(p[0]-cx)*1.025)),max(0,min(1,cy+(p[1]-cy)*1.025))] for p in corners]
    if len(corners) != 4 or any(not 0 <= n <= 1 for p in corners for n in p): raise ValueError('Four normalised paper corners required')
    points = [(p[0]*(image.width-1),p[1]*(image.height-1)) for p in corners]
    for i in range(4):
        p,q,r=points[i],points[(i+1)%4],points[(i+2)%4]
        if (q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0]) <= 0: raise ValueError('Corners must be clockwise TL TR BR BL')
    area=abs(sum(p[0]*points[(i+1)%4][1]-p[1]*points[(i+1)%4][0] for i,p in enumerate(points)))/2
    if area < image.width*image.height*.02: raise ValueError('Crop too small')
    width=max(math.dist(points[0],points[1]),math.dist(points[3],points[2]))
    height=max(math.dist(points[0],points[3]),math.dist(points[1],points[2]))
    scale=min(1,1400/width,6000/height); width=max(2,round(width*scale)); height=max(2,round(height*scale))
    a,b=[],[]
    for (x,y),(u,v) in zip([(0,0),(width-1,0),(width-1,height-1),(0,height-1)],points):
        a += [[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]; b += [u,v]
    result=image.transform((width,height),Image.Transform.PERSPECTIVE,solve(a,b),Image.Resampling.BICUBIC)
    result=ImageOps.autocontrast(result,cutoff=1).filter(ImageFilter.UnsharpMask(radius=1,percent=110,threshold=3))
    result.save(destination,'JPEG',quality=92,subsampling=0)
    print(json.dumps({'corners':corners,'edgeDetection':bool(detected),'width':width,'height':height}))

if __name__ == '__main__': scan(sys.argv[1],sys.argv[2],json.loads(sys.argv[3]),len(sys.argv)>4 and sys.argv[4]=='manual')
