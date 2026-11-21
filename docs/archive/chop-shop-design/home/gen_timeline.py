M = "'IBM Plex Mono', ui-monospace, monospace"
PRE = open('ClipSetup.dc.html').read()
PRE = PRE[:PRE.index('<div style="width: 1440px;')]

def ptabs(tabs, active):
    return ('<div style="display:flex;gap:2px;padding:0 8px;border-bottom:1px solid #2b2b35;background:#0a0a0e;">%s</div>'
        % ''.join('<span style="padding:7px 11px;font-family:%s;font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:%s;border-bottom:2px solid %s;">%s</span>'
        % (M, '#f2f1ee' if t==active else '#57545c', '#ff6076' if t==active else 'transparent', t) for t in tabs))

def lbl(t, c='#98959f'):
    return '<span style="font-family:%s;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.16em;color:%s;">%s</span>' % (M,c,t)

bin_rows = ''.join(
  '<div style="display:grid;grid-template-columns:14px minmax(0,1fr) 52px 34px;gap:8px;align-items:center;padding:5px 10px;%s">'
  '<span style="font-family:%s;font-size:9px;color:%s;">%s</span><span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">%s</span>'
  '<span style="font-family:%s;font-size:11px;color:#57545c;text-align:right;">%s</span><span style="font-family:%s;font-size:11px;color:#57545c;text-align:right;">%s</span></div>'
  % ('background:#21212a;' if i==0 else '', M, {'V':'#7fa8d4','A':'#8fc7a8','G':'#d4b37f'}[k], k, n, M, d, M, r)
  for i,(n,d,r,k) in enumerate([("church service.mp4","2:17:33","60p","V"),("b-roll congregation.mp4","0:42","60p","V"),
    ("logo sting.mov","0:03","60p","V"),("piano bed.wav","3:10","48k","A"),("lower third.png","-","-","G")]))

def kf(name, value, marks):
    dots = ''.join('<i style="position:absolute;left:%d%%;top:50%%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;transform:rotate(45deg);background:#ff6076;"></i>' % p for p in marks)
    return ('<div style="display:grid;grid-template-columns:92px 60px minmax(0,1fr);gap:8px;align-items:center;padding:3px 0;">'
        '<span style="font-size:12px;color:#98959f;">%s</span><span style="font-family:%s;font-size:11px;background:#08080b;border:1px solid #2b2b35;border-radius:2px;padding:2px 6px;text-align:right;">%s</span>'
        '<div style="position:relative;height:15px;background:#0a0a0e;border:1px solid #2b2b35;border-radius:2px;">%s</div></div>' % (name,M,value,dots))

tools = ''.join('<div style="width:29px;height:29px;display:flex;align-items:center;justify-content:center;border-radius:3px;font-family:%s;font-size:11px;font-weight:500;color:%s;%s">%s</div>'
  % (M, '#17090d' if on else '#98959f', 'background:#ff6076;' if on else 'background:#14141a;border:1px solid #2b2b35;', k)
  for k,on in [("V",1),("A",0),("B",0),("N",0),("R",0),("C",0),("Y",0),("U",0),("P",0),("H",0),("Z",0)])

def thead(name, targeted=False, muted=False, locked=False):
    def chip(t,on,col='#ff6076'):
        return ('<span style="width:16px;height:15px;display:flex;align-items:center;justify-content:center;border-radius:2px;font-family:%s;font-size:9px;color:%s;background:%s;">%s</span>'
            % (M, '#17090d' if on else '#57545c', col if on else '#14141a', t))
    return ('<div style="width:132px;flex:0 0 132px;display:flex;align-items:center;gap:4px;padding:0 8px;border-right:1px solid #2b2b35;">'
        '<span style="width:22px;font-family:%s;font-size:10px;color:%s;">%s</span><span style="width:14px;height:14px;border-radius:2px;background:%s;"></span>%s%s%s</div>'
        % (M, '#f2f1ee' if targeted else '#57545c', name, '#ff6076' if targeted else '#2b2b35', chip('M',muted), chip('S',False,'#d4b37f'), chip('L',locked,'#7fa8d4')))

def vclip(l,w,label,color,sel=False,trans=False):
    return ('<div style="position:absolute;left:%s%%;width:%s%%;top:3px;bottom:3px;border-radius:3px;overflow:hidden;background:repeating-linear-gradient(90deg,%s 0 26px,rgba(0,0,0,0.22) 26px 28px);border:1px solid %s;%s">'
        '<div style="position:absolute;left:0;top:0;right:0;padding:1px 5px;font-size:9px;color:#f2f1ee;background:rgba(8,8,11,0.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">%s</div>%s</div>'
        % (l,w,color,'#ff6076' if sel else 'rgba(0,0,0,0.5)','box-shadow:0 0 0 1px #ff6076;' if sel else '',label,
        '<div style="position:absolute;left:0;top:0;bottom:0;width:16px;background:linear-gradient(90deg,rgba(8,8,11,0.85),transparent);border-right:1px solid rgba(242,241,238,0.35);"></div>' if trans else ''))

def aclip(l,w,color,muted=False):
    bars = ''.join('<i style="display:block;width:2px;height:%d%%;background:rgba(242,241,238,0.45);"></i>' % h for h in [30,58,80,44,66,88,50,34,60,82,46,70,38,64,86,48,32,62,76,42,58,74,50,36,66,84,44,60,80,40])
    return ('<div style="position:absolute;left:%s%%;width:%s%%;top:3px;bottom:3px;border-radius:3px;background:%s;border:1px solid rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:space-between;padding:0 3px;overflow:hidden;%s">%s</div>'
        % (l,w,color,'opacity:0.35;' if muted else '',bars))

def lane(h,inner,height):
    return '<div style="display:flex;height:%dpx;border-bottom:1px solid #17171e;">%s<div style="flex-grow:1;position:relative;background:#0e0e13;">%s</div></div>' % (height,h,inner)

lanes = ''.join([
  lane(thead('V3'), vclip(30,14,'lower third.png','#6b5a3f'), 32),
  lane(thead('V2'), vclip(18,22,'b-roll congregation','#3f5a6b')+vclip(52,10,'logo sting','#5a3f6b'), 40),
  lane(thead('V1',targeted=True), vclip(2,44,'church service.mp4','#6b4a3f',sel=True)+vclip(46,40,'church service.mp4','#6b4a3f',trans=True), 54),
  lane(thead('A1',targeted=True), aclip(2,44,'#2f4a3a')+aclip(46,40,'#2f4a3a'), 38),
  lane(thead('A2'), aclip(18,22,'#2f4a3a'), 32),
  lane(thead('A3',muted=True), aclip(6,70,'#3a3a4a',muted=True), 28)])

ruler = ''.join('<span style="position:absolute;left:%d%%;bottom:3px;font-family:%s;font-size:9px;color:#57545c;">%s</span>' % (p,M,t)
  for p,t in [(0,'00:00:00'),(12,'00:00:30'),(24,'00:01:00'),(36,'00:01:30'),(48,'00:02:00'),(60,'00:02:30'),(72,'00:03:00'),(84,'00:03:30')])
marks = ''.join('<i style="position:absolute;left:%d%%;bottom:0;width:1px;height:%dpx;background:#2b2b35;"></i>' % (p, 6 if p%12 else 10) for p in range(0,100,3))

def meter(pct,peak):
    return ('<div style="width:9px;height:100%%;background:#0a0a0e;border:1px solid #2b2b35;border-radius:1px;position:relative;overflow:hidden;">'
        '<div style="position:absolute;left:0;right:0;bottom:0;height:%d%%;background:linear-gradient(180deg,#d4b37f,#3f9f6b);"></div>'
        '<i style="position:absolute;left:0;right:0;bottom:%d%%;height:1px;background:#ff6076;"></i></div>' % (pct,peak))

def mbar(tc,total,extra=''):
    return ('<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid #2b2b35;background:#0c0c11;">'
        '<div style="width:24px;height:24px;border-radius:999px;background:#21212a;border:1px solid #3d3d4a;display:flex;align-items:center;justify-content:center;">'
        '<svg width="9" height="9" viewBox="0 0 12 12" fill="#f2f1ee"><path d="M3 1.6 10 6l-7 4.4Z"></path></svg></div>'
        '<span style="font-family:%s;font-variant-numeric:tabular-nums;font-size:12px;">%s</span>'
        '<span style="font-family:%s;font-size:11px;color:#57545c;">/ %s</span><div style="flex-grow:1;"></div>%s</div>' % (M,tc,M,total,extra))

tabs = ''.join('<span style="font-size:12px;color:%s;%s">%s</span>' % ('#f2f1ee' if t=='Edit' else '#57545c','font-weight:500;' if t=='Edit' else '',t)
  for t in ['Assembly','Edit','Colour','Audio','Titles'])
fit = '<span style="padding:3px 9px;border-radius:999px;font-family:%s;font-size:10px;color:#98959f;background:#14141a;border:1px solid #2b2b35;">Fit</span>' % M

T = open('timeline_body.html').read()
out = PRE + (T.replace('{MONO}',M).replace('{TABS}',tabs).replace('{P1}',ptabs(['Project','Effects','Media'],'Project'))
  .replace('{P3}',ptabs(['Program','Source'],'Program'))
  .replace('{P4}',ptabs(['Effect controls','Lumetri','Audio'],'Effect controls'))
  .replace('{LNAME}',lbl('Name')).replace('{LDUR}',lbl('Dur')).replace('{LRATE}',lbl('Rate'))
  .replace('{LCLIP}',lbl('church service.mp4','#f2f1ee')).replace('{BINROWS}',bin_rows)
  .replace('{MBAR2}',mbar('00:01:12:04','00:04:38:11',fit))
  .replace('{KF1}',kf('Position','0.0, 0.0',[])+kf('Scale','118.0',[14,38,62])+kf('Rotation','0.0',[])+kf('Anchor','960, 540',[]))
  .replace('{KF2}',kf('Opacity','100.0',[4,92]))
  .replace('{KF3}',kf('Exposure','+0.20',[])+kf('Contrast','+8.0',[])+kf('LUT','Warm 01',[]))
  .replace('{METERS}',meter(72,78)+meter(66,74)).replace('{TOOLS}',tools).replace('{LANES}',lanes)
  .replace('{RULER}',ruler).replace('{MARKS}',marks))
open('Timeline.dc.html','w').write(out)
print('wrote Timeline.dc.html', len(out), 'bytes')
