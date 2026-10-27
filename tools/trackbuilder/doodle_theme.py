"""Ink outlined, hand illustrated dreamworld inspired by the owner's track.jpg."""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from chemical_theme import sky

INK = '#171827'
PAPER = '#eee9d8'

def textures(base, encode):
    result = {t[0]: t for t in base}
    def add(name, im):
        a=np.array(im.convert('RGBA'))
        result[name]=(name,im.width,im.height,1,0x08000000,0x6008,encode(a,1))
    for name in ('ROAD','RAIL','UNDER','VOID','SKY','INKGRID','BUBBLES'):
        size=256 if name=='SKY' else 128
        im=Image.new('RGB',(size,size),PAPER);d=ImageDraw.Draw(im)
        if name in ('ROAD','RAIL','UNDER','INKGRID'):
            colors=['#258fba','#6fcde5','#eee9d8','#43aa70','#b687ce']
            for j in range(4):
                for i in range(4):
                    x=i*32;y=j*32
                    d.rectangle((x,y,x+32,y+32),fill=colors[(i+j*3)%5],outline=INK,width=4)
                    d.line((x+5,y+6,x+25,y+6),fill='#e0f5ed',width=2)
            if name=='ROAD':
                d.rectangle((0,0,9,127),fill=INK);d.rectangle((118,0,127,127),fill=INK)
                d.rectangle((3,0,6,127),fill='#f1ce45');d.rectangle((121,0,124,127),fill='#f1ce45')
                d.line((64,10,64,44),fill=PAPER,width=3);d.line((64,75,64,109),fill=PAPER,width=3)
        elif name in ('BUBBLES','SKY'):
            rng=np.random.default_rng(2049)
            for i in range(50 if name=='SKY' else 16):
                x,y=rng.integers(0,size,2);r=int(rng.integers(5,19))
                d.ellipse((x-r,y-r,x+r,y+r),fill=['#50ae41','#964799','#26a9af'][i%3],outline=INK,width=3)
                d.ellipse((x-r//2,y-r//2,x-r//2+3,y-r//2+3),fill=PAPER)
        else:
            im.paste('#158ba9',(0,0,128,128));d=ImageDraw.Draw(im)
            for j in range(9):
                pts=[(x,j*16+int(5*math.sin(x/18+j))) for x in range(129)]
                d.line(pts,fill=PAPER if j%2 else '#194e78',width=3)
        add(name,im)
    # Landmark murals are taken directly from the supplied drawing, preserving its inkwork.
    ref=Image.open(Path(__file__).resolve().parents[2]/'track.jpg').convert('RGB')
    for name,box in [('GRIN',(0,240,380,715)),('SHARK',(438,310,850,665)),('DREAM',(130,80,570,350))]:
        add(name,ref.crop(box).resize((256,256),Image.Resampling.LANCZOS))
    return sorted(result.values(),key=lambda t:t[0])


def scenery(sec, tex_ids, Mesh, low):
    positions=np.array([s['pos'] for s in sec]);center=(positions.min(0)+positions.max(0))/2
    objects=[]
    for iz in range(-1,2):
        for ix in range(-1,2):
            origin=np.array([center[0]+ix*1100,low,center[2]+iz*1100]);m=Mesh(origin)
            m.texture(tex_ids['VOID'])
            for j in range(4):
                m.strip([(origin+[(i/4-.5)*1100,.25,((j+dz)/4-.5)*1100],(i/2,(j+dz)/2)) for i in range(5) for dz in (0,1)])
            objects.append((f'TRACK1L{80000+len(objects):05d}',m))
    def region(p):return min((m for _,m in objects),key=lambda m:np.linalg.norm((m.origin-p)[[0,2]]))
    def quad(m,pts,name):
        m.texture(tex_ids[name]);m.strip([(pts[i],uv) for i,uv in zip((0,1,3,2),((0,1),(1,1),(0,0),(1,0)))])
        m.strip([(pts[i],uv) for i,uv in zip((1,0,2,3),((1,1),(0,1),(1,0),(0,0)))])
    def panel(p,side,w,h,name):
        m=region(p);a=p-side*w/2;b=p+side*w/2
        quad(m,[a,b,b+[0,h,0],a+[0,h,0]],name)
    # Tall illustrated portals with generous clearance over the racing surface.
    for frac,name in ((.025,'DREAM'),(.31,'GRIN'),(.55,'SHARK'),(.79,'DREAM')):
        s=sec[int(len(sec)*frac)];p=s['pos'];side=s['S'];half=s['width']/2+30
        for sign in (-1,1):panel(p+side*half*sign+[0,-25,0],side,26,180,'INKGRID')
        panel(p+[0,115,0],side,2*half+28,100,name)
    # Alternating oversized gallery walls face the driver, outside the road envelope.
    for i,frac in enumerate((.12,.22,.40,.47,.65,.73,.87,.94)):
        s=sec[int(len(sec)*frac)];p=s['pos']+s['S']*(180 if i%2 else -180)
        if np.min(np.linalg.norm((positions-p)[:,[0,2]],axis=1))<120:continue
        panel(p+[0,-45,0],s['S'],160,200,('GRIN','BUBBLES','SHARK','DREAM')[i%4])
    # Sculptural ribbons turn the grid motif into a sequence of twisting arches.
    for frac in (.16,.175,.19,.205,.67,.685,.70):
        s=sec[int(len(sec)*frac)];p=s['pos'];side=s['S']
        forward=np.cross(side,[0,1,0]);m=region(p)
        m.texture(tex_ids['INKGRID'])
        for k in range(12):
            verts=[]
            for a in (k*math.pi/12,(k+1)*math.pi/12):
                for offset in (-10,10):
                    q=p+side*(100*math.cos(a))+[0,105*math.sin(a)+20,0]+forward*offset
                    verts.append((q,(a/math.pi*4,(offset+10)/20)))
            m.strip(verts)
    # Low polygon bubble clusters float above the water without adding placements.
    for i,frac in enumerate((.08,.26,.36,.58,.82,.91)):
        s=sec[int(len(sec)*frac)];p=s['pos']+s['S']*(240 if i%2 else -240)+[0,70,0]
        for j in range(3):
            c=p+[j*35,j*42,0];r=28-j*5;m=region(c);m.texture(tex_ids['BUBBLES'])
            for lat in range(6):
                verts=[]
                for lon in range(13):
                    a=lon*math.pi/6
                    for row in (lat+1,lat):
                        b=row*math.pi/6-math.pi/2
                        q=c+r*np.array([math.cos(b)*math.cos(a),math.sin(b),math.cos(b)*math.sin(a)])
                        verts.append((q,(lon/12,row/6)))
                m.strip(verts)
    return objects
