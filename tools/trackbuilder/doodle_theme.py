"""Midnight sketchbook: restrained racing surfaces, sculptural cartoon landmarks.

The owner's drawing informs the silhouettes and accent palette. The driving line
stays calm; contrast is concentrated on road edges, portals and flight landings.
"""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

INK = '#171e29'
PAPER = '#aaa48c'


def textures(base, encode):
    result = {t[0]: t for t in base}
    def add(name, im):
        a = np.array(im.convert('RGBA'))
        result[name] = (name, im.width, im.height, 1, 0x08000000, 0x6008, encode(a, 1))
    # Quiet asphalt with subtle grain. Color stays on the shoulders, outside the line.
    rng = np.random.default_rng(2049)
    road = np.full((128,128,3), [45,53,61.], float)
    road += rng.normal(0,1.1,(128,128,1))
    im = Image.fromarray(np.uint8(np.clip(road,0,255)));d = ImageDraw.Draw(im)
    for a,b in ((0,8),(119,127)):
        d.rectangle((a,0,b,127), fill='#202b35')
        for y in range(0,128,32):
            d.rectangle((a,y,b,y+24),fill=('#698c8b' if y%64==0 else '#77667d'))
    d.line((11,0,11,127),fill='#a8a28a',width=2)
    d.line((116,0,116,127),fill='#a8a28a',width=2)
    d.line((64,18,64,51),fill='#858d90',width=2)
    d.line((64,82,64,115),fill='#858d90',width=2)
    add('ROAD',im)
    for name in ('RAIL','UNDER','INKGRID','BUBBLES','TRIM','TEETH','DARK'):
        im=Image.new('RGB',(128,128),INK);d=ImageDraw.Draw(im)
        if name=='INKGRID':
            for j in range(4):
                for i in range(4):
                    col=('#3f6174','#557b83','#635073','#496966')[(i+j)%4]
                    d.rectangle((i*32,j*32,i*32+31,j*32+31),fill=col,outline=INK,width=3)
                    d.line((i*32+5,j*32+5,i*32+26,j*32+5),fill='#7c9292',width=1)
        elif name=='RAIL':
            d.rectangle((0,0,127,127),fill='#25343e')
            d.rectangle((0,33,127,39),fill='#587e83')
            d.rectangle((0,96,127,100),fill='#a19474')
            for x in range(0,128,32):d.rectangle((x,0,x+3,127),fill='#192530')
        elif name=='UNDER':
            d.rectangle((0,0,127,127),fill='#202d38')
            d.line((0,12,127,12),fill='#4b6570',width=3)
            d.line((0,112,127,112),fill='#4b6570',width=3)
        elif name=='BUBBLES':
            d.rectangle((0,0,127,127),fill='#425d62')
            d.ellipse((20,20,105,105),fill='#56757b',outline='#283f4e',width=5)
            d.arc((30,30,92,92),190,270,fill='#829697',width=4)
        elif name=='TRIM':d.rectangle((0,0,127,127),fill='#a58c62')
        elif name=='TEETH':
            d.rectangle((0,0,127,127),fill='#9d9b88')
            d.rectangle((0,0,127,16),fill='#c1b89b')
        add(name,im)
    # The horizon has depth, rather than a repeating wall of giant bright circles.
    im=Image.new('RGB',(256,256));px=np.zeros((256,256,3),np.uint8)
    for y in range(256):
        t=y/255
        px[y,:]=np.array([67,57,83])*(1-t)+np.array([15,23,39])*t
    im=Image.fromarray(px);d=ImageDraw.Draw(im)
    for k in range(7):
        x=k*43-12
        d.ellipse((x,26,x+70,48),fill='#364759')
        d.ellipse((x+15,17,x+53,43),fill='#364759')
    d.ellipse((181,150,209,178),fill='#7e8587')
    d.ellipse((173,147,203,174),fill='#18273b')
    add('SKY',im)
    im=Image.new('RGB',(128,128),'#203945');d=ImageDraw.Draw(im)
    for j in range(5):
        pts=[(x,j*28+int(3*math.sin(x/27+j))) for x in range(129)]
        d.line(pts,fill='#36515c',width=2)
        d.line([(x,y+5) for x,y in pts],fill='#263f4c',width=1)
    add('VOID',im)
    # A few small murals retain the actual linework, color graded into the environment.
    ref=Image.open(Path(__file__).resolve().parents[2]/'track.jpg').convert('RGB')
    for name,box in [('GRIN',(0,240,380,715)),('SHARK',(438,310,850,665)),('DREAM',(130,80,570,350))]:
        im=ref.crop(box).resize((256,256),Image.Resampling.LANCZOS)
        im=ImageEnhance.Color(im).enhance(.32)
        im=ImageEnhance.Brightness(im).enhance(.48)
        add(name,im)
    return sorted(result.values(),key=lambda t:t[0])


def sky(sec,tex_ids,Mesh):
    dome=Mesh(np.zeros(3))
    for lower in (False,True):
        dome.texture(tex_ids['VOID' if lower else 'SKY'])
        for row in range(4):
            verts=[]
            for k in range(33):
                theta=2*math.pi*k/32
                for r in (row+1,row):
                    a=math.pi*r/8
                    p=[2400*math.cos(a)*math.cos(theta),(-1 if lower else 1)*1500*math.sin(a),2400*math.cos(a)*math.sin(theta)]
                    verts.append((p,(k/32,r/4)))
            if lower:verts=[v for i in range(0,len(verts),2) for v in (verts[i+1],verts[i])]
            dome.strip(verts)
    return dome


def scenery(sec,tex_ids,Mesh,low,branches=()):
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
        m.texture(tex_ids[name])
        for order in ((0,1,3,2),(1,0,2,3)):
            m.strip([(pts[i],uv) for i,uv in zip(order,((0,1),(1,1),(0,0),(1,0)))])
    def tri(m,pts,name):
        m.texture(tex_ids[name])
        for order in ((0,1,2,2),(2,1,0,0)):
            m.strip([(pts[i],uv) for i,uv in zip(order,((0,1),(1,1),(.5,0),(.5,0)))])
    def panel(p,side,w,h,name):
        a=p-side*w/2;b=p+side*w/2
        quad(region(p),[a,b,b+[0,h,0],a+[0,h,0]],name)
    def sphere(p,r,name,stretch=(1,1,1)):
        m=region(p);m.texture(tex_ids[name])
        for lat in range(6):
            verts=[]
            for lon in range(13):
                a=lon*math.pi/6
                for row in (lat+1,lat):
                    b=row*math.pi/6-math.pi/2
                    q=p+r*np.array([math.cos(b)*math.cos(a),math.sin(b),math.cos(b)*math.sin(a)])*stretch
                    verts.append((q,(lon/12,row/6)))
            m.strip(verts)
    def arch(s,radius=100):
        p=s['pos'];side=s['S'];forward=s['T'];m=region(p)
        # Ink-edged volume, rather than an illustrated rectangle across the road.
        for k in range(16):
            angles=(k*math.pi/16,(k+1)*math.pi/16)
            for texture,ra,rb in (('DARK',radius-4,radius+22),('INKGRID',radius,radius+17)):
                pts=[p+side*(r*math.cos(a))+[0,r*math.sin(a)+18,0]-forward*4 for a,r in ((angles[0],ra),(angles[1],ra),(angles[1],rb),(angles[0],rb))]
                quad(m,pts,texture)
            for offset in (-9,9):
                pts=[p+side*(r*math.cos(a))+[0,r*math.sin(a)+18,0]+forward*offset for a,r in ((angles[0],radius),(angles[1],radius),(angles[1],radius+17),(angles[0],radius+17))]
                quad(m,pts,'INKGRID')
    # The grin is a real silhouette: mouth arch, small teeth and lidded cartoon eyes.
    s=sec[int(len(sec)*.07)];p=s['pos'];side=s['S'];forward=s['T']
    arch(s,112)
    for sign in (-1,1):
        eye=p+side*sign*52+[0,143,0]
        sphere(eye,23,'DARK',(1,1.15,.65))
        sphere(eye-forward*13,17,'TEETH',(1,1.1,.3))
        sphere(eye-forward*19+side*sign*3,8,'DARK',(1,1.1,.25))
    for x in (-66,-44,-22,0,22,44,66):
        y=18+math.sqrt(112**2-x*x)
        c=p+side*x+[0,y,0]-forward*10
        tri(region(c),[c-side*8,c+side*8,c+[0,-18,0]],'TEETH')
    # A handful of grid arches make a readable rhythm; keep flight corridors clear.
    for frac in (.145,.17,.195,.62,.65,.68):arch(sec[int(len(sec)*frac)])
    # Small framed artwork belongs in the roadside gallery, away from the horizon.
    for frac,name in ((.12,'DREAM'),(.43,'GRIN'),(.57,'SHARK'),(.87,'DREAM')):
        s=sec[int(len(sec)*frac)];p=s['pos']+s['S']*190+[0,-10,0]
        if np.min(np.linalg.norm((positions-p)[:,[0,2]],axis=1))<125:continue
        panel(p,s['S'],92,102,'DARK');panel(p-s['T']*2+[0,5,0],s['S'],82,92,name)
    # Giant shark fins break the lagoon surface; the tips stay outside every road.
    for frac,sign in ((.25,-1),(.36,1),(.51,-1),(.79,1)):
        s=sec[int(len(sec)*frac)];p=s['pos']+s['S']*sign*215+[0,-65,0]
        if np.min(np.linalg.norm((positions-p)[:,[0,2]],axis=1))<150:continue
        m=region(p);a=p-s['T']*85;b=p+s['T']*65;tip=p+[0,170,0]+s['T']*25
        tri(m,[a,b,tip],'INKGRID')
        tri(m,[a+s['S']*12,b+s['S']*12,tip],'UNDER')
        quad(m,[a,b,b+s['S']*12,a+s['S']*12],'DARK')
    # Sparse, large bubbles: sculptural landmarks without a field of busy dots.
    for i,frac in enumerate((.08,.45,.72)):
        s=sec[int(len(sec)*frac)];p=s['pos']+s['S']*(260 if i%2 else -260)+[0,20,0]
        for j in range(2):sphere(p+[j*38,j*46,0],30-j*7,'BUBBLES')
    for branch in branches:
        # Folded lips and guide fins flank the actual takeoff and landing decks.
        # They share the trim/ink materials and leave the road surface unpainted.
        for deck,is_landing in ((branch['sections'],False),(branch['landing'],True)):
            if not deck:continue
            q=deck[0 if is_landing else -1];m=region(q['pos'])
            for sign in (-1,1):
                edge=q['pos']+q['S']*sign*(q['width']/2+6)
                tri(m,[edge-q['T']*42,edge+q['T']*16,edge+[0,23,0]],'INKGRID')
                tri(m,[edge-q['T']*31+[0,1,0],edge+q['T']*8+[0,1,0],edge+[0,15,0]],'TRIM')
        # An understated fork sign: cream wing silhouette in an ink frame.
        q=sec[branch['entry']];sign=1 if branch['spec']['openings'][0]['side']=='R' else -1
        p=q['pos']+q['S']*sign*(q['width']/2+18)+[0,12,0]
        panel(p,q['S'],24,26,'DARK')
        tri(region(p),[p-q['S']*9+[0,18,0],p+[0,4,0],p+q['S']*9+[0,18,0]],'TEETH')
    return objects
