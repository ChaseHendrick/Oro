# Blender (bpy 4.5, Cycles) hero render of an Orograph landscape built from the app's own terrain data.
# usage: python render.py -- theme out width height samples data.json ['{"camEl":40,...}']
import bpy, json, sys, math, addon_utils
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
theme, out, W_, H_, samples = args[0], args[1], int(args[2]), int(args[3]), int(args[4])
data = json.load(open(args[5]))
dark = theme == 'dark'
P = dict(                # defaults = the final hero settings
    camEl=45.0,      # camera elevation above the orbit centre, degrees
    camAz=-28.0,     # camera azimuth around the orbit centre, degrees (0 = looking +y)
    camDist=12.6,    # distance from the orbit centre
    lens=40.0, shiftY=0.06, fstop=2.8,
    HZ=0.75,         # height scale (world units per terrain unit)
    contour=0.085,   # contour spacing in world height units
    lineW=1.15,      # contour line width in pixels at 1920 px wide (screen-space constant)
    idxW=2.0,        # index (every 5th) contour width
    fog0=10.0, fog1=21.0,
    exposure=0.25, noise=0.015,
)
if dark: P.update(orbE=1.4, trailE=2.6, bloom=1.0)
else: P.update(dotE=2.0, dotC='#ff5a10')
if len(args) > 6: P.update(json.loads(args[6]))

addon_utils.enable('cycles', default_set=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
addon_utils.enable('cycles', default_set=True)
scn = bpy.context.scene
scn.render.engine = 'CYCLES'
scn.cycles.device = 'CPU'
scn.cycles.samples = samples
scn.cycles.use_adaptive_sampling = True
scn.cycles.use_denoising = True
scn.cycles.denoiser = 'OPENIMAGEDENOISE'
scn.cycles.max_bounces = 4; scn.cycles.diffuse_bounces = 2; scn.cycles.glossy_bounces = 2
scn.cycles.transmission_bounces = 0; scn.cycles.volume_bounces = 0; scn.cycles.transparent_max_bounces = 2
scn.cycles.caustics_reflective = False; scn.cycles.caustics_refractive = False
scn.cycles.adaptive_threshold = P.get('noise', 0.02)
scn.cycles.sample_clamp_indirect = 6.0
scn.render.threads_mode = 'FIXED'; scn.render.threads = int(P.get('threads', 4))
scn.render.resolution_x, scn.render.resolution_y = W_, H_
scn.render.resolution_percentage = 100
scn.render.film_transparent = False
scn.render.image_settings.file_format = 'PNG'
scn.render.image_settings.color_mode = 'RGB'
scn.view_settings.view_transform = 'AgX'
scn.view_settings.look = 'AgX - Medium High Contrast' if dark else P.get('look', 'AgX - Medium High Contrast')
scn.view_settings.exposure = P['exposure']

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)
def hexc(h, a=1.0): return lin(h) + (a,)

# ---------------------------------------------------------------- terrain mesh
W, HZ = 10.0, P['HZ']
R, tiles, u0, grid = data['R'], data['tiles'], data['u0'], data['grid']
cx, cy = data['center']
def wpos(u, v, hh, lift=0.0): return Vector(((u - cx) * W, -(v - cy) * W, hh * HZ + lift))
verts = []
for j in range(R):
    v = u0 + tiles * j / (R - 1)
    for i in range(R):
        u = u0 + tiles * i / (R - 1)
        verts.append(((u - cx) * W, -(v - cy) * W, grid[j * R + i] * HZ))
faces = [(j * R + i, j * R + i + 1, (j + 1) * R + i + 1, (j + 1) * R + i) for j in range(R - 1) for i in range(R - 1)]
me = bpy.data.meshes.new('terrain'); me.from_pydata(verts, [], faces); me.update()
me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
terrain = bpy.data.objects.new('terrain', me); scn.collection.objects.link(terrain)

# ---------------------------------------------------------------- camera
oc = wpos(cx, cy, sum(o[2] for o in data['orbit']) / len(data['orbit']))
el, az = math.radians(P['camEl']), math.radians(P['camAz'])
cam_d = bpy.data.cameras.new('cam'); cam_d.lens = P['lens']; cam_d.sensor_width = 36; cam_d.sensor_fit = 'HORIZONTAL'
cam_d.shift_y = P['shiftY']; cam_d.clip_end = 200
cam = bpy.data.objects.new('cam', cam_d); scn.collection.objects.link(cam); scn.camera = cam
cdir = Vector((-math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
cam.location = oc + cdir * P['camDist']
cam.rotation_euler = (oc - cam.location).to_track_quat('-Z', 'Y').to_euler()
fwd = (oc - cam.location).normalized(); fwd_xy = Vector((fwd.x, fwd.y, 0)).normalized()
hfov = 2 * math.atan(18 / P['lens'])
PIX = 2 * math.tan(hfov / 2) / 1920.0   # world size of one 1920-px pixel per unit view distance

# ---------------------------------------------------------------- node helpers
class NT:
    def __init__(s, tree): s.t = tree; s.n = tree.nodes; s.l = tree.links
    def node(s, kind, **kw):
        x = s.n.new(kind)
        for k, v in kw.items(): setattr(x, k, v)
        return x
    def link(s, a, b): s.l.new(a, b)
    def _in(s, x, sock):
        if isinstance(x, (int, float)): sock.default_value = x
        elif x is not None: s.l.new(x, sock)
    def math(s, op, a, b=None, c=None, clamp=False):
        m = s.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        s._in(a, m.inputs[0]); s._in(b, m.inputs[1]); s._in(c, m.inputs[2]); return m.outputs[0]
    def vmath(s, op, a, b=None, sc=None):
        m = s.node('ShaderNodeVectorMath', operation=op)
        if isinstance(a, tuple): m.inputs[0].default_value = a
        else: s._in(a, m.inputs[0])
        if isinstance(b, tuple): m.inputs[1].default_value = b
        elif b is not None: s._in(b, m.inputs[1])
        if sc is not None: s._in(sc, m.inputs['Scale'])
        return m.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else m.outputs['Vector']
    def smooth(s, x, lo, hi):  # smoothstep(lo, hi, x) with linkable edges
        m = s.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        s._in(x, m.inputs['Value']); s._in(lo, m.inputs['From Min']); s._in(hi, m.inputs['From Max']); return m.outputs['Result']
    def sep(s, v):
        m = s.node('ShaderNodeSeparateXYZ'); s.l.new(v, m.inputs[0]); return m.outputs
    def mixc(s, f, a, b):
        m = s.node('ShaderNodeMix', data_type='RGBA')
        s._in(f, m.inputs['Factor'])
        for sock, c in ((m.inputs[6], a), (m.inputs[7], b)):
            if isinstance(c, str): sock.default_value = hexc(c)
            else: s.l.new(c, sock)
        return m.outputs[2]
    def ramp(s, f, stops):
        r = s.node('ShaderNodeValToRGB'); s._in(f, r.inputs['Fac']); cr = r.color_ramp
        cr.interpolation = 'B_SPLINE' if len(stops) > 2 else 'LINEAR'
        while len(cr.elements) > 2: cr.elements.remove(cr.elements[-1])
        cr.elements[0].position, cr.elements[0].color = stops[0][0], hexc(stops[0][1])
        cr.elements[1].position, cr.elements[1].color = stops[-1][0], hexc(stops[-1][1])
        for pos, col in stops[1:-1]:
            e = cr.elements.new(pos); e.color = hexc(col)
        return r.outputs['Color']

# Screen-space backdrop: what the far terrain fades into and what the sky shows. Built from the
# camera "Window" coordinate so the glow and stars sit where we want them in frame.
ASPECT = W_ / H_
def backdrop(g, win):
    wx, wy, _ = g.sep(win)
    if dark:
        base = g.ramp(wy, [(0.0, '#03050c'), (0.45, '#070b1d'), (0.8, '#0d1230'), (1.0, '#141739')])
        # warm horizon glow behind the far hills, slightly right of centre
        gx = g.math('MULTIPLY', g.math('SUBTRACT', wx, 0.6), ASPECT * 0.55)
        gy = g.math('SUBTRACT', wy, 1.08)
        r = g.math('SQRT', g.math('ADD', g.math('MULTIPLY', gx, gx), g.math('MULTIPLY', gy, gy)))
        glow = g.math('POWER', g.math('SUBTRACT', 1.0, g.smooth(r, 0.0, 0.75)), 2.2)
        gcol = g.ramp(glow, [(0.0, '#1a1638'), (0.45, '#4a2547'), (0.8, '#a2483e'), (1.0, '#e0794a')])
        col = g.mixc(g.math('MULTIPLY', glow, 0.9), base, gcol)
        # faint stars in the upper sky band
        vor = g.node('ShaderNodeTexVoronoi', voronoi_dimensions='2D', feature='F1')
        vor.inputs['Scale'].default_value = 140; vor.inputs['Randomness'].default_value = 1.0
        sc = g.node('ShaderNodeCombineXYZ'); g.link(g.math('MULTIPLY', wx, ASPECT), sc.inputs[0]); g.link(wy, sc.inputs[1])
        g.link(sc.outputs[0], vor.inputs['Vector'])
        sep = g.node('ShaderNodeSeparateColor'); g.link(vor.outputs['Color'], sep.inputs[0])
        rnd = sep.outputs[0]
        size = g.math('MULTIPLY_ADD', rnd, 0.05, 0.035)
        dotm = g.math('SUBTRACT', 1.0, g.smooth(vor.outputs['Distance'], 0.0, size))
        keep = g.math('GREATER_THAN', sep.outputs[1], 0.7)          # thin the field out
        band = g.smooth(wy, 0.84, 0.98)
        star = g.math('MULTIPLY', g.math('MULTIPLY', dotm, keep), g.math('MULTIPLY', band, g.math('MULTIPLY_ADD', rnd, 1.6, 0.25)))
        star = g.math('MULTIPLY', star, g.math('SUBTRACT', 1.0, g.math('MULTIPLY', glow, 0.8)))
        add = g.node('ShaderNodeMix', data_type='RGBA', blend_type='ADD'); add.inputs['Factor'].default_value = 1.0
        g.link(col, add.inputs[6]); g.link(g.mixc(star, '#000000', '#c9d4ff'), add.inputs[7])
        return add.outputs[2]
    base = g.ramp(wy, [(0.0, '#e6d9c2'), (0.5, '#efe5d3'), (1.0, '#f6eee0')])
    gx = g.math('MULTIPLY', g.math('SUBTRACT', wx, 0.6), ASPECT * 0.55)
    gy = g.math('SUBTRACT', wy, 1.08)
    r = g.math('SQRT', g.math('ADD', g.math('MULTIPLY', gx, gx), g.math('MULTIPLY', gy, gy)))
    glow = g.math('POWER', g.math('SUBTRACT', 1.0, g.smooth(r, 0.0, 0.7)), 2.0)
    return g.mixc(g.math('MULTIPLY', glow, 0.85), base, '#fcefdc')

def camera_gate(g, a_shader, cam_shader):
    lp = g.node('ShaderNodeLightPath'); mx = g.node('ShaderNodeMixShader')
    g.link(lp.outputs['Is Camera Ray'], mx.inputs[0]); g.link(a_shader, mx.inputs[1]); g.link(cam_shader, mx.inputs[2])
    return mx.outputs[0]

# ---------------------------------------------------------------- terrain material
mat = bpy.data.materials.new('land'); mat.use_nodes = True
g = NT(mat.node_tree); bsdf = g.n['Principled BSDF']; mout = g.n['Material Output']
geo = g.node('ShaderNodeNewGeometry'); tc = g.node('ShaderNodeTexCoord'); camd = g.node('ShaderNodeCameraData')
pos = geo.outputs['Position']; nrm = geo.outputs['Normal']; inc = geo.outputs['Incoming']
px, py, pz = g.sep(pos)
_, _, nz = g.sep(nrm)
# height colour
hf = g.math('MULTIPLY_ADD', pz, 1 / (2 * 0.85 * HZ), 0.5, clamp=True)
if dark:
    hcol = g.ramp(hf, [(0.0, '#05060f'), (0.3, '#111845'), (0.55, '#283282'), (0.78, '#4f5cb4'), (1.0, '#a0a6ec')])
else:
    hcol = g.ramp(hf, [(0.0, '#c8ae88'), (0.35, '#ddcaab'), (0.65, '#ebdec6'), (1.0, '#f8f0e1')])

# Contours with a constant on-screen width. Distance in height to the nearest level, divided by
# sin(slope) gives the distance along the surface; the screen width of that distance is
# view_distance * PIX / foreshortening, where foreshortening = |up-slope direction x view ray|.
sinS = g.math('MAXIMUM', g.math('SQRT', g.math('SUBTRACT', 1.0, g.math('MULTIPLY', nz, nz))), 1e-4)
upslope = g.vmath('NORMALIZE', g.vmath('SUBTRACT', (0.0, 0.0, 1.0), g.vmath('SCALE', nrm, sc=nz)))
dv = g.vmath('DOT_PRODUCT', upslope, inc)
fore = g.math('MAXIMUM', g.math('SQRT', g.math('SUBTRACT', 1.0, g.math('MULTIPLY', dv, dv))), 0.12)
pxw = g.math('DIVIDE', g.math('MULTIPLY', camd.outputs['View Distance'], PIX), fore)   # world size of one px, along slope
def contour(spacing, width_px):
    x = g.math('DIVIDE', pz, spacing)
    dz = g.math('MULTIPLY', g.math('ABSOLUTE', g.math('SUBTRACT', x, g.math('ROUND', x))), spacing)
    d = g.math('DIVIDE', dz, sinS)                  # surface distance to the line centre
    r = g.math('DIVIDE', d, g.math('MULTIPLY', pxw, 0.5 * width_px))
    return g.math('SUBTRACT', 1.0, g.smooth(r, 0.55, 1.35))
cs = P['contour']
minor = contour(cs, P['lineW']); major = contour(cs * 5, P['idxW'])

bsdf.inputs['Roughness'].default_value = 0.55 if dark else 0.9
if dark:
    bsdf.inputs['Base Color'].default_value = (0, 0, 0, 1)
    g.link(hcol, bsdf.inputs['Base Color'])
    bsdf.inputs['Specular IOR Level'].default_value = 0.35
    bsdf.inputs['Sheen Weight'].default_value = 0.25; bsdf.inputs['Sheen Roughness'].default_value = 0.3
    bsdf.inputs['Sheen Tint'].default_value = hexc('#c8d0ff')
    lines = g.math('MAXIMUM', g.math('MULTIPLY', minor, 0.55), major)
    lcol = g.mixc(major, '#5b66d6', '#9aa6ff')
    g.link(lcol, bsdf.inputs['Emission Color'])
    g.link(g.math('MULTIPLY', lines, 0.85), bsdf.inputs['Emission Strength'])
else:
    lines = g.math('MAXIMUM', g.math('MULTIPLY', minor, 0.62), g.math('MULTIPLY', major, 0.9))
    ink = g.mixc(major, '#7a5236', '#55331d')
    g.link(g.mixc(lines, hcol, ink), bsdf.inputs['Base Color'])
    bsdf.inputs['Specular IOR Level'].default_value = 0.2

# Distance fog into the backdrop (camera rays only, so indirect light is unaffected).
dist = camd.outputs['View Distance']
fog = g.math('POWER', g.smooth(dist, P['fog0'] + (0 if dark else 3), P['fog1'] + (0 if dark else 4)), 1.4)
em = g.node('ShaderNodeEmission'); g.link(backdrop(g, tc.outputs['Window']), em.inputs['Color'])
fmix = g.node('ShaderNodeMixShader'); g.link(fog, fmix.inputs[0]); g.link(bsdf.outputs[0], fmix.inputs[1]); g.link(em.outputs[0], fmix.inputs[2])
g.link(camera_gate(g, bsdf.outputs[0], fmix.outputs[0]), mout.inputs['Surface'])
mat.cycles.emission_sampling = 'NONE'   # contour glow is a texture, not a light source
terrain.data.materials.append(mat)

# ---------------------------------------------------------------- world
world = bpy.data.worlds.new('w'); scn.world = world; world.use_nodes = True
wg = NT(world.node_tree); bg = wg.n['Background']; wout = wg.n['World Output']
amb = wg.node('ShaderNodeBackground'); amb.inputs['Color'].default_value = hexc('#121a3c' if dark else '#efe0c8')
amb.inputs['Strength'].default_value = 0.35 if dark else P.get('amb', 0.55)
wtc = wg.node('ShaderNodeTexCoord')
wg.link(backdrop(wg, wtc.outputs['Window']), bg.inputs['Color']); bg.inputs['Strength'].default_value = 1.0
lp = wg.node('ShaderNodeLightPath'); mx = wg.node('ShaderNodeMixShader')
wg.link(lp.outputs['Is Camera Ray'], mx.inputs[0]); wg.link(amb.outputs[0], mx.inputs[1]); wg.link(bg.outputs[0], mx.inputs[2])
wg.link(mx.outputs[0], wout.inputs['Surface'])
world.cycles.sampling_method = 'NONE'

# ---------------------------------------------------------------- orbit + dot
def emit_mat(name, col, strength, base=None, metallic=0.0, rough=0.35):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nn = m.node_tree.nodes; b = nn['Principled BSDF']
    b.inputs['Base Color'].default_value = hexc(base or col); b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metallic
    m.cycles.emission_sampling = 'NONE'   # the dot's point light does the local lighting
    b.inputs['Emission Color'].default_value = hexc(col); b.inputs['Emission Strength'].default_value = strength
    return m

orbit = data['orbit']; n_orb = len(orbit)
ORANGE = '#ff7a45' if dark else '#b05a26'
LIFT = 0.05
def tube(name, pts, radius, mat, radii=None, cyclic=False):
    cd = bpy.data.curves.new(name, 'CURVE'); cd.dimensions = '3D'; cd.bevel_depth = radius; cd.bevel_resolution = 4
    cd.use_fill_caps = True
    sp = cd.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for k, p in enumerate(pts):
        sp.points[k].co = (p.x, p.y, p.z, 1)
        if radii: sp.points[k].radius = radii[k]
    sp.use_cyclic_u = cyclic
    ob = bpy.data.objects.new(name, cd); scn.collection.objects.link(ob); ob.data.materials.append(mat)
    ob.visible_shadow = not dark   # copper wire casts a soft shadow on the paper in daylight
    return ob
opts = [wpos(u, v, hh, LIFT) for u, v, hh in orbit]
tube('orbit', opts, 0.026 if dark else 0.03, (emit_mat('orbitm', ORANGE, P.get('orbE', 3.2), base='#ff9a6a') if dark else emit_mat('orbitm', '#c8642a', P.get('orbE', 0.25), base='#b5602e', metallic=0.85, rough=0.3)), cyclic=True)
# a brighter comet trail just behind the dot (the dot travels with increasing phase)
kd = int(round(data['dotT'] * n_orb)) % n_orb
TL = int(n_orb * 0.16)
trail = [opts[(kd - TL + k) % n_orb] for k in range(TL + 1)]
radii = [0.25 + 0.75 * (k / TL) ** 1.6 for k in range(TL + 1)]
tube('trail', trail, 0.05 if dark else 0.05, (emit_mat('trailm', '#ff8a52', P.get('trailE', 6.0), base='#ffc0a0') if dark else emit_mat('trailm', '#ff7a2a', P.get('trailE', 0.7), base='#c96a30', metallic=0.75, rough=0.25)), radii=radii)

du, dv, dh = data['dot']
DR = 0.17 if dark else 0.19
dpos = wpos(du, dv, dh, LIFT + DR * 0.9)
bpy.ops.mesh.primitive_uv_sphere_add(radius=DR, location=dpos, segments=64, ring_count=32)
dot = bpy.context.active_object; bpy.ops.object.shade_smooth()
dm = bpy.data.materials.new('dotm'); dm.use_nodes = True
db = dm.node_tree.nodes['Principled BSDF']
db.inputs['Base Color'].default_value = hexc('#fff1e6' if dark else '#f0a060'); db.inputs['Roughness'].default_value = 0.1
db.inputs['Coat Weight'].default_value = 1.0
db.inputs['Emission Color'].default_value = hexc('#ffd2b0' if dark else P.get('dotC', '#ff6c1e')); db.inputs['Emission Strength'].default_value = 26 if dark else P.get('dotE', 2.8)
dot.data.materials.append(dm); dot.visible_shadow = False
ld = bpy.data.lights.new('dotlight', 'POINT'); ld.energy = 55 if dark else P.get('dotL', 34)
ld.color = lin('#ff8f5a'); ld.shadow_soft_size = DR
lo = bpy.data.objects.new('dotlight', ld); lo.location = dpos + Vector((0, 0, 0.05)); scn.collection.objects.link(lo)
cam_d.dof.use_dof = True; cam_d.dof.aperture_fstop = P['fstop']; cam_d.dof.focus_object = dot

# ---------------------------------------------------------------- lights
def sun(name, energy, col, elev, azim, angle):
    s = bpy.data.lights.new(name, 'SUN'); s.energy = energy; s.color = lin(col); s.angle = math.radians(angle)
    o = bpy.data.objects.new(name, s); scn.collection.objects.link(o)
    d = Vector((math.cos(math.radians(elev)) * math.cos(math.radians(azim)), math.cos(math.radians(elev)) * math.sin(math.radians(azim)), math.sin(math.radians(elev))))
    o.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler(); return o
caz = math.degrees(math.atan2(-fwd_xy.y, -fwd_xy.x))     # azimuth pointing from the scene toward the camera
if dark:
    sun('key', P.get('key', 1.3), '#a8b8ff', 30, caz + 75, 3)        # cool moonlight from camera-left
    sun('rim', P.get('rim', 0.5), '#ff9478', 9, caz + 180 - 18, 2)    # warm rim from the glow behind the hills
else:
    sun('key', P.get('key', 3.6), '#fff0dc', 32, caz + 70, 9)          # soft warm daylight
    sun('rim', P.get('rim', 0.9), '#ffd7b0', 12, caz + 180 - 20, 6)

# ---------------------------------------------------------------- compositor: bloom + vignette
scn.use_nodes = True
ct = scn.node_tree; cn = ct.nodes; cl = ct.links
for x in list(cn): cn.remove(x)
rl = cn.new('CompositorNodeRLayers')
gl = cn.new('CompositorNodeGlare'); gl.glare_type = 'BLOOM'; gl.quality = 'HIGH'
gl.inputs['Threshold'].default_value = 0.7 if dark else 1.4
gl.inputs['Strength'].default_value = P.get('bloom', 0.85 if dark else 0.5)
gl.inputs['Size'].default_value = P.get('bloomSize', 0.66 if dark else 0.55)
gl.inputs['Smoothness'].default_value = 0.4
cl.new(rl.outputs['Image'], gl.inputs['Image'])
ic = cn.new('CompositorNodeImageCoordinates'); cl.new(rl.outputs['Image'], ic.inputs['Image'])
sx = cn.new('CompositorNodeSeparateXYZ'); cl.new(ic.outputs['Normalized'], sx.inputs[0])
def cmath(op, a, b):
    m = cn.new('CompositorNodeMath'); m.operation = op
    for sock, v in ((m.inputs[0], a), (m.inputs[1], b)):
        if isinstance(v, (int, float)): sock.default_value = v
        else: cl.new(v, sock)
    return m.outputs[0]
vx = cmath('SUBTRACT', sx.outputs[0], 0.5); vy = cmath('SUBTRACT', sx.outputs[1], 0.5)
rr = cmath('ADD', cmath('MULTIPLY', vx, vx), cmath('MULTIPLY', vy, vy))
vig = cmath('SUBTRACT', 1.0, cmath('MULTIPLY', rr, P.get('vignette', 1.0 if dark else 0.45)))
mul = cn.new('CompositorNodeMixRGB'); mul.blend_type = 'MULTIPLY'
mul.inputs[0].default_value = 1.0; cl.new(gl.outputs['Image'], mul.inputs[1]); cl.new(vig, mul.inputs[2])
comp = cn.new('CompositorNodeComposite'); cl.new(mul.outputs[0], comp.inputs['Image'])
if 'border' in P:
    scn.render.use_border = True; scn.render.use_crop_to_border = True
    (scn.render.border_min_x, scn.render.border_max_x, scn.render.border_min_y, scn.render.border_max_y) = P['border']
scn.render.filepath = out
print('camera', tuple(round(c, 2) for c in cam.location), 'orbit centre', tuple(round(c, 2) for c in oc), 'dot', tuple(round(c, 2) for c in dpos))
bpy.ops.render.render(write_still=True)
print('rendered', out)
