/* Packet Highway — 3D scene + HUD.
   Each captured packet spawns a vehicle; protocol decides the vehicle type.
   Packets attributed to a process carry the app's icon as a floating sprite. */

(function () {
  'use strict';

  // ------------------------------------------------------------ config
  var Q = new URLSearchParams(location.search);
  var WALLPAPER = Q.get('wallpaper') === '1';
  var ECO = Q.get('eco') === '1';
  // static hosting (GitHub Pages, file://) has no capture backend — synthesize traffic client-side
  var STATIC = Q.get('static') === '1' ||
    location.protocol === 'file:' || /(^|\.)github\.io$/.test(location.hostname);
  if (WALLPAPER) { document.body.classList.add('wallpaper'); document.title = 'PacketHighwayWallpaper'; }

  var MAX_CARS = ECO ? 50 : (WALLPAPER ? 110 : 200);
  var FPS_CAP = ECO ? 24 : (WALLPAPER ? 30 : 60);
  // native-resolution rendering ("4K quality"); eco mode stays cheap
  var PIXEL_RATIO = ECO ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  var BUILDING_COUNT = ECO ? 22 : 52;

  // protocol -> vehicle definition (colors match the legend)
  var VEHICLES = {
    https: { veh: 'City bus',   proto: 'HTTPS',     color: 0x4d8df0, css: '#4d8df0', speed: 22, len: 9.0 },
    quic:  { veh: 'Sports car', proto: 'QUIC',      color: 0xf0405a, css: '#f0405a', speed: 44, len: 4.2 },
    http:  { veh: 'Box truck',  proto: 'HTTP',      color: 0xf08c2e, css: '#f08c2e', speed: 20, len: 8.0 },
    dns:   { veh: 'Motorcycle', proto: 'DNS',       color: 0xf0d048, css: '#f0d048', speed: 38, len: 2.2 },
    ssh:   { veh: 'Taxi',       proto: 'SSH',       color: 0x30c878, css: '#30c878', speed: 30, len: 4.5 },
    tcp:   { veh: 'Sedan',      proto: 'TCP other', color: 0x38d4d0, css: '#38d4d0', speed: 30, len: 4.6 },
    udp:   { veh: 'Panel van',  proto: 'UDP other', color: 0xa86df0, css: '#a86df0', speed: 26, len: 5.6 },
    icmp:  { veh: 'Police car', proto: 'ICMP ping', color: 0xf0f4f8, css: '#f0f4f8', speed: 34, len: 4.8 },
    arp:   { veh: 'Bicycle',    proto: 'ARP',       color: 0xc8ccd4, css: '#c8ccd4', speed: 10, len: 1.8 },
    other: { veh: 'Hatchback',  proto: 'Other',     color: 0x8a8f99, css: '#8a8f99', speed: 28, len: 3.8 }
  };
  var PROTO_LABEL = { https: 'HTTPS', quic: 'QUIC', http: 'HTTP', dns: 'DNS', ssh: 'SSH', tcp: 'TCP', udp: 'UDP', icmp: 'ICMP', arp: 'ARP', other: 'OTHER' };

  // ------------------------------------------------------------ renderer
  var canvas = document.getElementById('scene');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !ECO, powerPreference: ECO ? 'low-power' : 'default' });
  renderer.setPixelRatio(PIXEL_RATIO);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // filmic grade — the whole retro-future look keys off this
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x131a30);
  scene.fog = new THREE.Fog(0x131a30, 130, 430);

  var camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 1200);
  var camTarget = new THREE.Vector3(-2, 0, -50);
  var camYaw = 0.62, camPitch = 0.30, camDist = 95;
  function applyCamera() {
    camera.position.set(
      camTarget.x + camDist * Math.sin(camYaw) * Math.cos(camPitch),
      camTarget.y + camDist * Math.sin(camPitch),
      camTarget.z + camDist * Math.cos(camYaw) * Math.cos(camPitch));
    camera.lookAt(camTarget);
  }
  applyCamera();

  var hemi = new THREE.HemisphereLight(0x3a4a78, 0x1a1238, 1.25); // indigo sky, violet bounce
  scene.add(hemi);
  var dl = new THREE.DirectionalLight(0x9db8e8, 0.7);
  dl.position.set(-130, 90, -260);
  scene.add(dl);

  // --------------------------------------------------- sky (retro-future)
  var starsMat, starsMat2;
  var domeGeo, sunSprite, sunHalo, daySun, pollutionMat;
  var nightGlow = []; // glow elements hidden in daylight
  var starsScale = 1, envExpo = 1, envRain = 0, envSnow = false, rainFallSpeed = 45;
  var envDayW = 0;             // 0 = night .. 1 = full day (set by applyEnvironment)
  var buildingsList = [];      // facade materials swap night<->day textures
  var skylineMats = [];        // distant silhouettes get hazed in daylight
  var bulbOff = null, bulbOffW = 0; // lamp bulbs go dark in daylight
  function setDomeColors(topHex, midHex, horHex) {
    var pos = domeGeo.attributes.position, col = domeGeo.attributes.color;
    var top = new THREE.Color(topHex), mid = new THREE.Color(midHex), hor = new THREE.Color(horHex);
    for (var i = 0; i < pos.count; i++) {
      var t = Math.max(0, Math.min(1, pos.getY(i) / 900));
      var c2 = t < 0.18 ? hor.clone().lerp(mid, t / 0.18) : mid.clone().lerp(top, (t - 0.18) / 0.82);
      col.setXYZ(i, c2.r, c2.g, c2.b);
    }
    col.needsUpdate = true;
  }
  (function sky() {
    // vertex-colored dome: recolored live by time-of-day (see applyEnvironment)
    domeGeo = new THREE.SphereGeometry(900, 16, 12);
    domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(domeGeo.attributes.position.count * 3), 3));
    scene.add(new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
    setDomeColors(0x05060f, 0x1a1238, 0x3a2450);

    // two star layers, twinkled in the loop by whole-material opacity
    function starLayer(count, size, opacity) {
      var sp = [];
      for (var s = 0; s < count; s++) {
        var az = Math.random() * Math.PI * 2, el2 = 0.08 + Math.random() * 1.4;
        sp.push(850 * Math.cos(el2) * Math.sin(az), 850 * Math.sin(el2), 850 * Math.cos(el2) * Math.cos(az) * -1);
      }
      var g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      var m2 = new THREE.PointsMaterial({ color: 0xbfd0ff, size: size, sizeAttenuation: false, transparent: true, opacity: opacity, fog: false });
      scene.add(new THREE.Points(g2, m2));
      return m2;
    }
    starsMat = starLayer(260, 2.2, 0.8);
    starsMat2 = starLayer(180, 1.4, 0.5);

    // the synthwave sun: striped gradient disc low on the horizon
    var c = document.createElement('canvas'); c.width = 256; c.height = 256;
    var g3 = c.getContext('2d');
    var grad = g3.createLinearGradient(0, 20, 0, 236);
    grad.addColorStop(0, '#ffb04a'); grad.addColorStop(0.55, '#ff5e8a'); grad.addColorStop(1, '#c026c9');
    g3.fillStyle = grad;
    g3.beginPath(); g3.arc(128, 128, 108, 0, Math.PI * 2); g3.fill();
    g3.globalCompositeOperation = 'destination-out';
    for (var st = 0; st < 7; st++) { // widening scanline gaps toward the bottom
      var sy = 128 + 14 + st * (10 + st * 2.4);
      g3.fillRect(0, sy, 256, 3 + st * 1.7);
    }
    var sunTex = new THREE.CanvasTexture(c);
    sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false }));
    sunSprite.scale.set(230, 230, 1);
    sunSprite.position.set(-40, 70, -800);
    scene.add(sunSprite);
    sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex('rgba(255,94,138,0.5)'), transparent: true, fog: false,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7
    }));
    sunHalo.scale.set(420, 420, 1);
    sunHalo.position.copy(sunSprite.position);
    scene.add(sunHalo);

    // daytime sun: plain bright disc that arcs east->west with the real clock
    // (the striped synthwave sun is for night/golden hour and fades out by day)
    daySun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex('rgba(255,250,232,1)'), transparent: true, fog: false,
      depthWrite: false, opacity: 0
    }));
    daySun.scale.set(150, 150, 1);
    daySun.position.set(-40, 340, -800);
    scene.add(daySun);

    // light-pollution band: a soft horizon glow so the night sky never
    // bottoms out to pure black behind the skyline
    var pc = document.createElement('canvas'); pc.width = 4; pc.height = 128;
    var pg = pc.getContext('2d');
    var pgrad = pg.createLinearGradient(0, 128, 0, 0);
    pgrad.addColorStop(0, 'rgba(255,255,255,0.85)');
    pgrad.addColorStop(1, 'rgba(255,255,255,0)');
    pg.fillStyle = pgrad; pg.fillRect(0, 0, 4, 128);
    pollutionMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(pc), transparent: true, fog: false,
      depthWrite: false, color: 0x3a2450, opacity: 0.5
    });
    var pol = new THREE.Mesh(new THREE.PlaneGeometry(1500, 230), pollutionMat);
    pol.position.set(0, 100, -560);
    scene.add(pol);
  })();

  // shared helper: radial gradient texture (glow sprites, light pools)
  function radialTex(rgba) {
    var c = document.createElement('canvas'); c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, rgba); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  // ----------------------------------------- real vehicle models (CC0, Kenney)
  // minimal GLB reader — enough for Kenney's car kit (one material, no skins,
  // no draco). Models swap in over the procedural boxes when loaded; if a
  // fetch or parse fails the procedural vehicle stays (STATIC/file:// safe).
  function parseGLB(buf) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not glb');
    var jsonLen = dv.getUint32(12, true);
    var json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    return { json: json, bin: buf.slice(20 + jsonLen + 8) };
  }
  function accArray(g, idx) {
    var a = g.json.accessors[idx], bv = g.json.bufferViews[a.bufferView];
    var off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    var len = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]);
    if (a.componentType === 5126) return new Float32Array(g.bin, off, len);
    if (a.componentType === 5125) return new Uint32Array(g.bin, off, len);
    return new Uint16Array(g.bin, off, len);
  }
  function buildGLB(g, mat) {
    var json = g.json;
    function nodeObj(ni) {
      var n = json.nodes[ni];
      var o = new THREE.Group();
      o.name = n.name || '';
      if (n.mesh != null) {
        json.meshes[n.mesh].primitives.forEach(function (pr) {
          var geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(accArray(g, pr.attributes.POSITION), 3));
          if (pr.attributes.NORMAL != null) geo.setAttribute('normal', new THREE.BufferAttribute(accArray(g, pr.attributes.NORMAL), 3));
          if (pr.attributes.TEXCOORD_0 != null) geo.setAttribute('uv', new THREE.BufferAttribute(accArray(g, pr.attributes.TEXCOORD_0), 2));
          if (pr.indices != null) geo.setIndex(new THREE.BufferAttribute(accArray(g, pr.indices), 1));
          o.add(new THREE.Mesh(geo, mat));
        });
      }
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
      (n.children || []).forEach(function (ci) { o.add(nodeObj(ci)); });
      return o;
    }
    var root = new THREE.Group();
    json.scenes[json.scene || 0].nodes.forEach(function (ni) { root.add(nodeObj(ni)); });
    return root;
  }
  // the kit's palette texture, grayscaled so material.color tints the whole
  // vehicle to its protocol color (windows/tires stay darker shades)
  var glbTex = {};
  function grayTexture(url, key, cb) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      var id = g.getImageData(0, 0, c.width, c.height), px = id.data;
      for (var i = 0; i < px.length; i += 4) {
        var l = Math.min(255, (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) * 1.75 + 26);
        px[i] = px[i + 1] = px[i + 2] = l;
      }
      g.putImageData(id, 0, 0);
      var tex = new THREE.CanvasTexture(c);
      tex.flipY = false; // glTF UV convention
      glbTex[key] = tex;
      cb();
    };
    img.onerror = function () { cb(); };
    img.src = url;
  }
  var MODELS = {
    https: { url: 'models/van.glb', bus: true }, // kitbash: stretched van = city bus
    quic: { url: 'models/sedan-sports.glb' },
    http: { url: 'models/delivery.glb' },
    ssh:  { url: 'models/taxi.glb' },
    tcp:  { url: 'models/sedan.glb' },
    udp:  { url: 'models/van.glb' },
    icmp: { url: 'models/police.glb' },
    dns:  { url: 'models/motorcycle.glb', tex: 'moto' },
    other: { url: 'models/hatchback-sports.glb' }
  };
  var DEBRIS = []; // crash-scene props (tire, bumper, door, cone)
  function fetchGLB(url, cb) {
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.arrayBuffer();
    }).then(function (buf) { cb(parseGLB(buf)); })
      .catch(function (e) { console.warn('[models] ' + url + ' failed (' + e.message + ') — procedural fallback'); });
  }
  // stretch a van into a city bus: longer body, wheels pushed out, third axle
  function busify(root) {
    var backs = [];
    root.traverse(function (o) {
      if (o.name === 'body' || o.name === 'door') o.scale.z = 1.6;
      else if (o.name && o.name.indexOf('wheel') === 0) {
        o.position.z *= 1.6;
        if (o.name.indexOf('back') >= 0) backs.push(o);
      }
    });
    backs.forEach(function (wb) {
      var mid = wb.clone();
      mid.position.z = 0;
      wb.parent.add(mid);
    });
  }
  function glbVehicle(key, root) {
    var def = VEHICLES[key];
    var inner = new THREE.Group();
    inner.add(root);
    inner.rotation.y = Math.PI; // kit models face +z; our vehicles drive -z
    var g = new THREE.Group();
    g.add(inner);
    var bb = new THREE.Box3().setFromObject(g);
    var s = def.len / Math.max(0.001, bb.max.z - bb.min.z);
    inner.scale.setScalar(s);
    inner.position.y = -bb.min.y * s;
    inner.position.z = -(bb.min.z + bb.max.z) / 2 * s; // center on origin
    bb = new THREE.Box3().setFromObject(g);
    var w = bb.max.x - bb.min.x;
    // brake-light strip on the rear (4-wheelers; bikes have none) + police bar
    if (key !== 'dns' && key !== 'arp')
      box(g, Math.min(2.2, w * 0.62), 0.16, 0.08, MAT.tail,
          0, Math.min(1.1, Math.max(0.5, bb.max.y * 0.45)), bb.max.z - 0.05).name = 'tail';
    // head lamps + tail bloom so models read as lit vehicles at night
    [-w * 0.28, w * 0.28].forEach(function (hx) {
      box(g, 0.32, 0.2, 0.08, MAT.head, hx, Math.min(0.9, bb.max.y * 0.4), bb.min.z + 0.04);
    });
    if (!MAT.tailGlow) MAT.tailGlow = new THREE.SpriteMaterial({
      map: radialTex('rgba(255,64,56,0.65)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8
    });
    var tgl = new THREE.Sprite(MAT.tailGlow);
    tgl.scale.set(1.5, 0.8, 1);
    tgl.position.set(0, Math.min(1.0, bb.max.y * 0.42), bb.max.z + 0.25);
    g.add(tgl);
    if (key === 'icmp') {
      box(g, 0.42, 0.2, 0.4, MAT.red, -0.28, bb.max.y + 0.08, 0).name = 'flashR';
      box(g, 0.42, 0.2, 0.4, MAT.blue, 0.28, bb.max.y + 0.08, 0).name = 'flashB';
    }
    return g;
  }
  function loadVehicleModels() {
    var after = function () {
      Object.keys(MODELS).forEach(function (key) {
        var texKey = MODELS[key].tex || 'cars';
        if (!glbTex[texKey]) return;
        fetchGLB(MODELS[key].url, function (g) {
          try {
            var def = VEHICLES[key];
            var mat = new THREE.MeshLambertMaterial({
              map: glbTex[texKey], color: def.color,
              emissive: def.color, emissiveIntensity: 0.3
            });
            var root = buildGLB(g, mat);
            if (MODELS[key].bus) busify(root);
            TEMPLATES[key] = buildTemplate(key, glbVehicle(key, root));
          } catch (e) { }
        });
      });
      // crash debris props
      if (glbTex.cars) {
        var dmat = new THREE.MeshLambertMaterial({ map: glbTex.cars, color: 0x4a5160, emissive: 0x20242e, emissiveIntensity: 0.4 });
        ['models/debris-tire.glb', 'models/debris-bumper.glb', 'models/debris-door.glb', 'models/cone.glb'].forEach(function (u) {
          fetchGLB(u, function (g) {
            try {
              var d = buildGLB(g, u.indexOf('cone') >= 0
                ? new THREE.MeshLambertMaterial({ map: glbTex.cars, color: 0xff8030, emissive: 0xff8030, emissiveIntensity: 0.35 })
                : dmat);
              d.scale.setScalar(2.2);
              DEBRIS.push(d);
            } catch (e) { }
          });
        });
      }
    };
    var pend = 2;
    grayTexture('models/colormap-cars.png', 'cars', function () { if (--pend === 0) after(); });
    grayTexture('models/colormap-moto.png', 'moto', function () { if (--pend === 0) after(); });
  }

  // ------------------------------------------------------------ world
  var ROAD_LEN = 480, Z0 = -ROAD_LEN / 2 - 60, Z1 = ROAD_LEN / 2 - 60; // road spans z in [Z0, Z1]
  var LANE_W = 4.2;
  // left roadway (x<0): traffic toward camera (in). right roadway: away (out).
  var LANE_MIN = 4, LANE_MAX = 6;
  var targetLanes = LANE_MIN; // bandwidth opens extra lanes (see stats handler)
  var lanesIn = [], lanesOut = [], roadMeshes = [];

  function laneX(i) { return 4.8 + 2.1 + i * LANE_W; } // i = 0 innermost (next to median)

  function roadTexture(n) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 256;
    var g = c.getContext('2d');
    g.fillStyle = '#06080d'; g.fillRect(0, 0, 256, 256); // wet-asphalt dark base
    g.fillStyle = 'rgba(255,255,255,0.045)';
    for (var i = 0; i < 380; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    g.fillStyle = 'rgba(190,205,225,0.03)';
    for (var i2 = 0; i2 < 120; i2++) g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
    var lw = 256 / n; // n lanes => n-1 dashed separators + solid edges
    for (var wl = 0; wl < n; wl++) { // tire-wear darkening down each lane centre
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(lw * wl + lw / 2 - lw / 6, 0, lw / 3, 256);
    }
    g.fillStyle = 'rgba(10,14,22,0.5)'; // oil stains
    for (var os = 0; os < 6; os++) {
      g.beginPath();
      g.ellipse(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 7, 10 + Math.random() * 16, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#aeb6c2'; g.lineWidth = 3; g.setLineDash([26, 30]);
    for (var l = 1; l < n; l++) {
      g.beginPath(); g.moveTo(lw * l, 0); g.lineTo(lw * l, 256); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = '#e8d23c'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(3, 0); g.lineTo(3, 256); g.stroke();
    g.strokeStyle = '#d8dce4'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(253, 0); g.lineTo(253, 256); g.stroke();
    var tx = new THREE.CanvasTexture(c);
    tx.wrapS = THREE.ClampToEdgeWrapping; tx.wrapT = THREE.RepeatWrapping;
    tx.repeat.set(1, ROAD_LEN / 36);
    return tx;
  }

  // painted direction labels on each roadway (which side is download vs upload)
  var laneLabels = [];
  function laneLabelTex(text, color) {
    var c = document.createElement('canvas'); c.width = 1024; c.height = 256; // 2x for crisp text
    var g = c.getContext('2d');
    g.scale(2, 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 40px Consolas, monospace';
    g.shadowColor = color; g.shadowBlur = 14;
    g.fillStyle = color;
    g.fillText(text, 256, 64);
    return new THREE.CanvasTexture(c);
  }
  function buildRoads(n) {
    roadMeshes.forEach(function (m) {
      scene.remove(m);
      m.geometry.dispose(); m.material.map.dispose(); m.material.dispose();
    });
    roadMeshes = [];
    laneLabels.forEach(function (m) {
      scene.remove(m);
      m.geometry.dispose(); m.material.map.dispose(); m.material.dispose();
    });
    laneLabels = [];
    var width = n * LANE_W + 1.2, cx = 4.8 + n * LANE_W / 2;
    [[-cx, false], [cx, true]].forEach(function (s) {
      var mat = new THREE.MeshLambertMaterial({ map: roadTexture(n) });
      mat.color.setScalar(1 + envDayW * 0.55); // asphalt lightens a touch in daylight
      var m = new THREE.Mesh(new THREE.PlaneGeometry(width, ROAD_LEN), mat);
      m.rotation.x = -Math.PI / 2;
      if (s[1]) m.rotation.z = Math.PI; // yellow edge faces the median on both sides
      m.position.set(s[0], 0.01, (Z0 + Z1) / 2);
      scene.add(m);
      roadMeshes.push(m);
      // continuation slabs past both ends so the highway runs into the fog
      [[Z0 - 180, false], [Z1 + 180, true]].forEach(function (e) {
        var ext = new THREE.Mesh(new THREE.PlaneGeometry(width, 360), mat);
        ext.rotation.x = -Math.PI / 2;
        if (s[1]) ext.rotation.z = Math.PI;
        ext.position.set(s[0], 0.008, e[0]);
        scene.add(ext);
        roadMeshes.push(ext);
      });
    });
    [[-cx, '▼ IN · DOWNLOAD ▼', '#7fd8ff'],
     [cx, '▲ OUT · UPLOAD ▲', '#ffb866']].forEach(function (cfg) {
      [-6, -126].forEach(function (lz) {
        var m = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(width - 1.6, 17), 4.4),
          new THREE.MeshBasicMaterial({
            map: laneLabelTex(cfg[1], cfg[2]), transparent: true,
            depthWrite: false, opacity: 0.92
          }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(cfg[0], 0.04, lz);
        m.renderOrder = 1;
        scene.add(m);
        laneLabels.push(m);
      });
    });
  }

  function syncLaneFactors() { // outer lanes flow faster, like a real highway
    var n = lanesIn.length;
    for (var i = 0; i < n; i++) {
      var f = 0.88 + (n === 1 ? 0 : 0.30 * i / (n - 1)); // i = inner -> outer
      lanesIn[n - 1 - i].f = f;
      lanesOut[i].f = f;
    }
  }
  function addLanePair() {
    var i = lanesIn.length;
    lanesIn.unshift({ x: -laneX(i), cars: [], closed: false });
    lanesOut.push({ x: laneX(i), cars: [], closed: false });
    syncLaneFactors();
    buildRoads(lanesIn.length);
  }
  function openLaneCount() {
    var n = 0; lanesIn.forEach(function (l) { if (!l.closed) n++; });
    return n;
  }
  // grow/shrink the highway toward targetLanes; closing lanes drain first, then vanish
  function laneController() {
    var open = openLaneCount();
    if (targetLanes > open) {
      if (lanesIn[0].closed) { lanesIn[0].closed = false; lanesOut[lanesOut.length - 1].closed = false; }
      else if (lanesIn.length < LANE_MAX) addLanePair();
    } else if (targetLanes < open && open > LANE_MIN) {
      for (var i = 0; i < lanesIn.length; i++) if (!lanesIn[i].closed) { lanesIn[i].closed = true; break; }
      for (var j = lanesOut.length - 1; j >= 0; j--) if (!lanesOut[j].closed) { lanesOut[j].closed = true; break; }
    }
    var changed = false;
    while (lanesIn.length > LANE_MIN &&
           lanesIn[0].closed && lanesIn[0].cars.length === 0 &&
           lanesOut[lanesOut.length - 1].closed && lanesOut[lanesOut.length - 1].cars.length === 0) {
      lanesIn.shift(); lanesOut.pop(); changed = true;
    }
    if (changed) { syncLaneFactors(); buildRoads(lanesIn.length); }
    lanesEl.textContent = openLaneCount() * 2;
  }

  for (var li = 0; li < LANE_MIN; li++) {
    lanesIn.unshift({ x: -laneX(li), cars: [], closed: false });
    lanesOut.push({ x: laneX(li), cars: [], closed: false });
  }
  syncLaneFactors();
  buildRoads(LANE_MIN);

  // ground + median
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshLambertMaterial({ color: 0x05070d }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; scene.add(ground);
  var median = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, ROAD_LEN),
    new THREE.MeshLambertMaterial({ color: 0x141926 }));
  median.position.set(0, 0.35, (Z0 + Z1) / 2); scene.add(median);
  // neon edge strips on the median (TRON accent, unlit = glows under ACES)
  var neonMat = new THREE.MeshBasicMaterial({ color: 0x2ee6e0 });
  [-1.52, 1.52].forEach(function (nx) {
    var strip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, ROAD_LEN), neonMat);
    strip.position.set(nx, 0.72, (Z0 + Z1) / 2); scene.add(strip);
    nightGlow.push(strip);
  });

  // street lights along the median + static glow package (pools, halos, wet streaks)
  var poleMat = new THREE.MeshLambertMaterial({ color: 0x1a2030 });
  var bulbMat = new THREE.MeshBasicMaterial({ color: 0xf8edc8 });
  var bulbWarm = new THREE.Color(0xf8edc8), bulbCool = new THREE.Color(0xcfe8ff);
  (function streetlights() {
    var lampZ = [];
    for (var z = Z0 + 20; z < Z1; z += 46) lampZ.push(z);
    lampZ.forEach(function (z) {
      var pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9, 0.35), poleMat);
      pole.position.set(0, 4.5, z); scene.add(pole);
      var bulb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.6), bulbMat);
      bulb.position.set(0, 9, z); scene.add(bulb);
    });

    // one instanced mesh per effect: all lamps cost 1 draw call each
    var poolGeo = new THREE.PlaneGeometry(13, 9); poolGeo.rotateX(-Math.PI / 2);
    var poolMat = new THREE.MeshBasicMaterial({
      map: radialTex('rgba(255,236,190,0.75)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    var pools = new THREE.InstancedMesh(poolGeo, poolMat, lampZ.length);
    var streakGeo = new THREE.PlaneGeometry(2.0, 24); streakGeo.rotateX(-Math.PI / 2);
    var streakMat = new THREE.MeshBasicMaterial({
      map: radialTex('rgba(255,220,170,0.5)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    var streaks = new THREE.InstancedMesh(streakGeo, streakMat, lampZ.length * 2);
    var m4 = new THREE.Matrix4();
    lampZ.forEach(function (z, i) {
      m4.setPosition(0, 0.025, z); pools.setMatrixAt(i, m4);
      m4.setPosition(-8, 0.02, z + 6); streaks.setMatrixAt(i * 2, m4);
      m4.setPosition(8, 0.02, z + 6); streaks.setMatrixAt(i * 2 + 1, m4);
    });
    pools.renderOrder = 2; streaks.renderOrder = 2;
    scene.add(pools); scene.add(streaks);
    nightGlow.push(pools, streaks);

    // bulb halo sprites
    var haloMat = new THREE.SpriteMaterial({
      map: radialTex('rgba(255,240,200,0.55)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    lampZ.forEach(function (z) {
      var s = new THREE.Sprite(haloMat);
      s.scale.set(5, 3.4, 1); s.position.set(0, 9, z);
      scene.add(s);
      nightGlow.push(s);
    });
  })();

  // buildings with lit windows (night) / concrete facades (day);
  // varied window-grid cell sizes so the skyline isn't one repeated facade
  function buildingTexture(day, cell) {
    cell = cell || 9;
    var c = document.createElement('canvas'); c.width = 64; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = day ? '#67737f' : '#070a12'; g.fillRect(0, 0, 64, 128);
    var palette = day ? ['#2c3644', '#333f4e', '#3b4856'] : ['#e8d8a8', '#c8d8f0', '#f0c890', '#a8c8e8'];
    var wW = Math.max(3, cell - 4), wH = Math.max(2, cell - 5);
    for (var y = 6; y < 128 - cell; y += cell)
      for (var x = 5; x < 64 - cell; x += cell)
        if (day || Math.random() < 0.24) {
          g.fillStyle = palette[(Math.random() * palette.length) | 0];
          g.globalAlpha = day ? 0.9 : 0.5 + Math.random() * 0.5;
          g.fillRect(x, y, wW, wH);
        }
    g.globalAlpha = 1;
    return new THREE.CanvasTexture(c);
  }
  var _bCells = [9, 8, 11, 9, 12, 7];
  var bTex = _bCells.map(function (cl) { return buildingTexture(false, cl); });
  var bTexDay = _bCells.map(function (cl) { return buildingTexture(true, cl); });
  var roofMat = new THREE.MeshBasicMaterial({ color: 0x222936 });
  var procBuildings = []; // skyline towers bound to real processes (see handleProcs)
  var bbCandidates = [];
  // city blocks: buildings sit on a row/slot grid (3 rows per side) so they
  // never interpenetrate — the gaps between rows read as back avenues
  var bLots = [];
  [-1, 1].forEach(function (side) {
    for (var row = 0; row < 3; row++) {
      var rx = side * (58 + row * 36);
      var zc = Z0 - 20;
      while (zc < Z1 + 10) {
        var ld = 14 + Math.random() * 14;
        var cz = zc + ld / 2;
        zc += ld + 8 + Math.random() * 12;
        if (side < 0 && row === 0 && cz > -175 && cz < -10) continue; // app-city district
        if (side > 0 && row === 0 && cz > -155 && cz < -25) continue; // utilities district
        if (row === 0 && cz > -80) continue;                          // camera clearing
        bLots.push({ x: rx + side * Math.random() * 5, z: cz, d: ld });
      }
    }
  });
  bLots.sort(function () { return Math.random() - 0.5; });
  bLots = bLots.slice(0, BUILDING_COUNT);
  for (var b = 0; b < bLots.length; b++) {
    var w = 14 + Math.random() * 14, h = 20 + Math.random() * 55, d = bLots[b].d;
    var bx = bLots[b].x;
    var bz = bLots[b].z;
    // tile the window texture by building size so windows stay sharp
    var tex = bTex[b % bTex.length].clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, Math.round(w / 14)), Math.max(1, Math.round(h / 26)));
    tex.needsUpdate = true;
    var dtex = bTexDay[b % bTexDay.length].clone();
    dtex.wrapS = dtex.wrapT = THREE.RepeatWrapping;
    dtex.repeat.copy(tex.repeat);
    dtex.needsUpdate = true;
    // faked sun shading: +x/+z faces lit, -x/-z faces in shade, flat roof slab
    var jit = 0.86 + Math.random() * 0.26; // per-building albedo so no two match
    var matLit = new THREE.MeshBasicMaterial({ map: tex });
    var matShade = new THREE.MeshBasicMaterial({ map: tex });
    matLit.color.setScalar(jit);
    matShade.color.setScalar(jit * 0.66);
    buildingsList.push({ mat: matLit, night: tex, day: dtex });
    buildingsList.push({ mat: matShade, night: tex, day: dtex });
    // unit-height box scaled live: each skyline tower tracks a real process
    // (height = its RAM share, window brightness = its CPU use)
    var bld = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d),
      [matLit, matShade, roofMat, roofMat, matLit, matShade]);
    bld.scale.y = h;
    bld.position.set(bx, h / 2 - 0.1, bz);
    scene.add(bld);
    // rooftop clutter (AC units / tanks) breaks the flat-slab silhouette
    var roof = new THREE.Group();
    for (var rc = 0, rcn = 1 + (Math.random() * 2 | 0); rc < rcn; rc++) {
      var rw = 2 + Math.random() * Math.min(6, w * 0.25);
      box(roof, rw, 1.2 + Math.random() * 2.4, rw, poleMat,
          (Math.random() - 0.5) * w * 0.5, 0.8, (Math.random() - 0.5) * d * 0.5);
    }
    roof.position.set(bx, h - 0.1, bz);
    scene.add(roof);
    var rec = { mesh: bld, lit: matLit, shade: matShade, jit: jit, roof: roof, night: tex, day: dtex, w: w, cur: h, target: h, label: null, labelName: null, pinned: false };
    procBuildings.push(rec);
    if (h > 40 && Math.abs(bx) < 150 && bz > -260 && bz < 20)
      bbCandidates.push({ x: bx, h: h, w: w, d: d, z: bz, rec: rec });
  }

  // living billboards: jumbotrons on the tallest road-facing buildings showing
  // the top-talker apps (icon + relative traffic bar), redrawn every 5 s
  var iconBytes = {}, bbImgCache = {};
  var billboards = [];
  bbCandidates.sort(function (a, b2) { return b2.h - a.h; }).slice(0, ECO ? 0 : 3).forEach(function (cd) {
    cd.rec.pinned = true; // jumbotron hosts keep their height (board is bolted on)
    var c = document.createElement('canvas'); c.width = 512; c.height = 512; // 2x for crisp text
    var tex = new THREE.CanvasTexture(c);
    c.getContext('2d').scale(2, 2);
    var size = Math.min(cd.w * 0.8, 13);
    var m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex }));
    m.position.set(cd.x + (cd.x < 0 ? cd.w / 2 + 0.2 : -cd.w / 2 - 0.2), cd.h * 0.72, cd.z);
    m.rotation.y = cd.x < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(m);
    billboards.push({ ctx: c.getContext('2d'), tex: tex });
  });
  function redrawBillboards() {
    if (!billboards.length) return;
    var top = Object.keys(iconBytes).sort(function (a, b2) { return iconBytes[b2] - iconBytes[a]; }).slice(0, 3);
    var max = top.length ? iconBytes[top[0]] : 1;
    billboards.forEach(function (bb) {
      var g = bb.ctx;
      g.fillStyle = '#070d18'; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = '#57b8e8'; g.lineWidth = 6; g.strokeRect(5, 5, 246, 246);
      g.font = 'bold 19px Consolas, monospace'; g.fillStyle = '#6f8fb8'; g.textAlign = 'left';
      g.fillText('NOW STREAMING', 18, 36);
      top.forEach(function (key, i) {
        var y = 60 + i * 64;
        var img = bbImgCache[key];
        if (!img) {
          img = bbImgCache[key] = new Image();
          img.src = '/icon/' + key + '.png';
          img.onload = redrawBillboards;
        }
        if (img.complete && img.naturalWidth) g.drawImage(img, 18, y, 48, 48);
        g.fillStyle = '#2a3a5c'; g.fillRect(80, y + 16, 158, 16);
        g.fillStyle = '#4fd2ff'; g.fillRect(80, y + 16, Math.max(8, 158 * (iconBytes[key] / max)), 16);
      });
      if (!top.length) { g.fillStyle = '#33415e'; g.font = '17px Consolas'; g.fillText('no traffic yet', 18, 80); }
      bb.tex.needsUpdate = true;
    });
    Object.keys(iconBytes).forEach(function (k) {
      iconBytes[k] *= 0.8;
      if (iconBytes[k] < 100) delete iconBytes[k];
    });
  }
  setInterval(redrawBillboards, 5000);

  // distant parallax skyline silhouettes (camera drift sells the depth)
  (function skyline() {
    function layer(wpx, hpx, tint, w3, h3, z3) {
      var c = document.createElement('canvas'); c.width = wpx; c.height = hpx;
      var g = c.getContext('2d');
      g.fillStyle = tint;
      var x = 0;
      while (x < wpx) {
        var bw = 30 + Math.random() * 70, bh = hpx * (0.35 + Math.random() * 0.6);
        g.fillRect(x, hpx - bh, bw, bh);
        x += bw + 6 + Math.random() * 18;
      }
      g.fillStyle = 'rgba(255,225,170,0.5)';
      for (var d = 0; d < wpx * hpx / 900; d++) {
        var dx = Math.random() * wpx, dy = hpx * 0.3 + Math.random() * hpx * 0.65;
        if (g.getImageData(dx, dy, 1, 1).data[3] > 0) g.fillRect(dx, dy, 1.5, 1.5);
      }
      var tex = new THREE.CanvasTexture(c);
      var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false });
      skylineMats.push(mat);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w3, h3), mat);
      m.position.set(0, h3 / 2 - 2, z3);
      scene.add(m);
    }
    layer(1024, 200, '#232b47', 900, 130, -350);
    layer(1024, 220, '#1a2038', 1000, 165, -430);
    layer(1024, 240, '#12182c', 1150, 200, -510);
  })();

  // "PACKET HIGHWAY" sign over the median — subtitle updates with live stats
  var signCtx, signTex;
  var lastPing = -1, lastServers = 0;
  function redrawSign() {
    var g = signCtx;
    g.shadowBlur = 0;
    g.fillStyle = '#0a1322'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#57b8e8'; g.lineWidth = 5; g.strokeRect(6, 6, 500, 116);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 46px Consolas, monospace';
    g.shadowColor = '#57b8e8'; g.shadowBlur = 16;
    g.fillStyle = '#bfe8ff'; g.fillText('PACKET HIGHWAY', 256, 46);
    g.font = '22px Consolas, monospace';
    g.shadowBlur = 8;
    g.fillStyle = '#6fd2a8';
    var sub = lastServers + ' SERVERS' +
      (lastPing >= 0 ? ' · ' + lastPing + ' MS' : '') +
      ' · ' + (openLaneCount() * 2) + ' LANES';
    g.fillText(sub, 256, 96);
    signTex.needsUpdate = true;
  }
  (function sign() {
    var c = document.createElement('canvas'); c.width = 1024; c.height = 256; // 2x for crisp text at 4K
    signCtx = c.getContext('2d');
    signCtx.scale(2, 2);
    signTex = new THREE.CanvasTexture(c);
    redrawSign();
    var board = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5),
      new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide }));
    board.position.set(0, 10.5, -28);
    board.rotation.y = 0.25;
    scene.add(board);
    var pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8, 0.5), poleMat);
    pole.position.set(0, 4, -28); scene.add(pole);
    setInterval(redrawSign, 5000);
  })();

  // exit gantries over the outbound lanes — show where traffic is headed
  var destCounts = {};
  var gantries = [];
  (function exitGantries() {
    [[-95, 'EXIT 12'], [-175, 'EXIT 25']].forEach(function (cfg) {
      var c = document.createElement('canvas'); c.width = 1024; c.height = 192; // 2x for crisp text
      var ctx = c.getContext('2d');
      ctx.scale(2, 2);
      var tex = new THREE.CanvasTexture(c);
      var board = new THREE.Mesh(new THREE.PlaneGeometry(20, 3.8),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      board.position.set(13.5, 9.4, cfg[0]);
      scene.add(board);
      [4.6, 22.4].forEach(function (px) {
        var pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 11, 0.4), poleMat);
        pole.position.set(px, 5.5, cfg[0]); scene.add(pole);
      });
      var beam = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.5, 0.5), poleMat);
      beam.position.set(13.5, 11.3, cfg[0]); scene.add(beam);
      gantries.push({ ctx: ctx, tex: tex, label: cfg[1] });
    });
    setInterval(redrawGantries, 8000);
    redrawGantries();
  })();
  function redrawGantries() {
    var names = Object.keys(destCounts).sort(function (a, b) { return destCounts[b] - destCounts[a]; });
    gantries.forEach(function (g2, i) {
      var ctx = g2.ctx;
      ctx.clearRect(0, 0, 512, 96);
      ctx.fillStyle = 'rgba(8,30,20,0.94)'; ctx.fillRect(0, 0, 512, 96);
      ctx.strokeStyle = '#3ad08a'; ctx.lineWidth = 4; ctx.strokeRect(4, 4, 504, 88);
      ctx.font = '20px Consolas, monospace'; ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left'; ctx.fillStyle = '#7ce8b0';
      ctx.fillText(g2.label, 18, 32);
      var picks = names.slice(i * 2, i * 2 + 2);
      ctx.font = 'bold 33px Consolas, monospace';
      ctx.textAlign = 'center'; ctx.fillStyle = '#eafff2';
      ctx.fillText(picks.length ? picks.join(' · ') : 'OPEN ROAD', 256, 72);
      g2.tex.needsUpdate = true;
    });
    Object.keys(destCounts).forEach(function (k) {
      destCounts[k] *= 0.55;
      if (destCounts[k] < 0.5) delete destCounts[k];
    });
  }

  // ------------------------------------------------------------ vehicles
  var matCache = {};
  function lambert(color) {
    // self-emissive accent keeps protocol colors saturated under the ACES grade
    if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({ color: color, emissive: color, emissiveIntensity: 0.32 });
    return matCache[color];
  }
  var MAT = {
    glass: new THREE.MeshLambertMaterial({ color: 0x0d1422, emissive: 0x202c44, emissiveIntensity: 0.85 }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff2c4 }),
    tail: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    tailBright: new THREE.MeshBasicMaterial({ color: 0xff5040 }),
    tire: new THREE.MeshLambertMaterial({ color: 0x090a0e }),
    dark: new THREE.MeshLambertMaterial({ color: 0x10141e, emissive: 0x141b2c, emissiveIntensity: 0.55 }),
    red: new THREE.MeshBasicMaterial({ color: 0xff2a3c }),
    blue: new THREE.MeshBasicMaterial({ color: 0x2a7cff })
  };

  function box(g, w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); g.add(m); return m;
  }
  function wheels(g, w, len, r) {
    r = r || 0.42;
    // one under-skirt box instead of four wheels: reads the same at night,
    // cuts per-car draw calls substantially
    box(g, w * 0.92, r * 1.4, len * 0.8, MAT.tire, 0, r * 0.7, 0);
  }
  // every factory builds a car pointing toward -z (drives "forward" = -z); flipped per lane dir
  var FACTORY = {
    https: function () { // city bus
      var g = new THREE.Group(), c = lambert(VEHICLES.https.color);
      box(g, 2.5, 2.5, 9, c, 0, 1.7, 0);
      box(g, 2.54, 0.9, 7.6, MAT.glass, 0, 2.45, 0.2);
      box(g, 2.2, 0.5, 0.1, MAT.head, 0, 1.1, -4.51);
      box(g, 2.2, 0.4, 0.1, MAT.tail, 0, 1.2, 4.51).name = 'tail';
      wheels(g, 2.1, 9, 0.5);
      return g;
    },
    quic: function () { // sports car
      var g = new THREE.Group(), c = lambert(VEHICLES.quic.color);
      box(g, 2.1, 0.55, 4.2, c, 0, 0.65, 0);
      box(g, 1.9, 0.45, 2.0, MAT.glass, 0, 1.12, 0.2);
      box(g, 1.7, 0.18, 0.4, c, 0, 1.0, 2.0); // spoiler
      box(g, 1.7, 0.22, 0.08, MAT.head, 0, 0.62, -2.12);
      box(g, 1.7, 0.2, 0.08, MAT.tail, 0, 0.66, 2.12).name = 'tail';
      wheels(g, 1.8, 4.2, 0.38);
      return g;
    },
    http: function () { // box truck
      var g = new THREE.Group(), c = lambert(VEHICLES.http.color);
      box(g, 2.4, 2.6, 5.4, c, 0, 1.85, 1.2);                 // cargo box
      box(g, 2.2, 1.5, 2.2, MAT.dark, 0, 1.0, -2.7);          // cab
      box(g, 2.1, 0.6, 0.1, MAT.glass, 0, 1.45, -3.8);
      box(g, 1.9, 0.3, 0.1, MAT.head, 0, 0.65, -3.82);
      box(g, 2.2, 0.4, 0.1, MAT.tail, 0, 1.0, 3.95).name = 'tail';
      wheels(g, 2.0, 8, 0.5);
      return g;
    },
    dns: function () { // motorcycle
      var g = new THREE.Group(), c = lambert(VEHICLES.dns.color);
      box(g, 0.5, 0.5, 2.0, c, 0, 0.8, 0);
      box(g, 0.4, 0.7, 0.4, MAT.dark, 0, 1.35, 0.3); // rider
      box(g, 0.34, 0.34, 0.1, MAT.head, 0, 0.85, -1.06);
      box(g, 0.3, 0.7, 0.7, MAT.tire, 0, 0.42, -0.85);
      box(g, 0.3, 0.7, 0.7, MAT.tire, 0, 0.42, 0.85);
      return g;
    },
    ssh: function () { // taxi
      var g = sedanBody(VEHICLES.ssh.color);
      box(g, 0.9, 0.32, 0.5, MAT.head, 0, 1.85, 0); // roof sign
      return g;
    },
    tcp: function () { return sedanBody(VEHICLES.tcp.color); },
    udp: function () { // panel van
      var g = new THREE.Group(), c = lambert(VEHICLES.udp.color);
      box(g, 2.2, 1.9, 5.6, c, 0, 1.35, 0);
      box(g, 2.24, 0.6, 1.4, MAT.glass, 0, 1.8, -1.7);
      box(g, 1.9, 0.3, 0.1, MAT.head, 0, 0.7, -2.81);
      box(g, 1.9, 0.35, 0.1, MAT.tail, 0, 0.9, 2.81).name = 'tail';
      wheels(g, 1.9, 5.6, 0.42);
      return g;
    },
    icmp: function () { // police car
      var g = sedanBody(VEHICLES.icmp.color);
      var r = box(g, 0.5, 0.25, 0.45, MAT.red, -0.32, 1.78, 0);
      var bl = box(g, 0.5, 0.25, 0.45, MAT.blue, 0.32, 1.78, 0);
      r.name = 'flashR'; bl.name = 'flashB';
      return g;
    },
    arp: function () { // bicycle
      var g = new THREE.Group(), c = lambert(VEHICLES.arp.color);
      box(g, 0.18, 0.35, 1.6, c, 0, 0.75, 0);
      box(g, 0.3, 0.75, 0.3, MAT.dark, 0, 1.3, 0.1); // rider
      box(g, 0.16, 0.6, 0.6, MAT.tire, 0, 0.35, -0.7);
      box(g, 0.16, 0.6, 0.6, MAT.tire, 0, 0.35, 0.7);
      return g;
    },
    other: function () { // hatchback
      var g = new THREE.Group(), c = lambert(VEHICLES.other.color);
      box(g, 2.0, 0.8, 3.8, c, 0, 0.85, 0);
      box(g, 1.9, 0.7, 1.9, MAT.glass, 0, 1.55, 0.4);
      box(g, 1.7, 0.26, 0.1, MAT.head, 0, 0.75, -1.91);
      box(g, 1.7, 0.26, 0.1, MAT.tail, 0, 0.85, 1.91).name = 'tail';
      wheels(g, 1.7, 3.8, 0.38);
      return g;
    }
  };
  function sedanBody(color) {
    var g = new THREE.Group(), c = lambert(color);
    box(g, 2.1, 0.75, 4.6, c, 0, 0.85, 0);
    box(g, 1.95, 0.65, 2.3, MAT.glass, 0, 1.55, 0.1);
    box(g, 1.8, 0.26, 0.1, MAT.head, 0, 0.75, -2.31);
    box(g, 1.8, 0.26, 0.1, MAT.tail, 0, 0.85, 2.31).name = 'tail';
    wheels(g, 1.8, 4.6, 0.4);
    return g;
  }

  // one template per vehicle type; clones share geometries and materials,
  // so spawning never allocates GPU resources (critical for a 24/7 wallpaper)
  var TEMPLATES = {};
  // neon ribbon trails on the fast movers (built once per template, clones share)
  var TRAIL = { quic: { len: 10, color: 0xff2d5e }, dns: { len: 6.5, color: 0xffd84f } };
  var trailTexCache = null;
  function trailTexture() {
    if (trailTexCache) return trailTexCache;
    var c = document.createElement('canvas'); c.width = 64; c.height = 8;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 8);
    trailTexCache = new THREE.CanvasTexture(c);
    return trailTexCache;
  }
  function getTemplate(proto) {
    var key = proto in FACTORY ? proto : 'other';
    if (!TEMPLATES[key]) TEMPLATES[key] = buildTemplate(key, FACTORY[key]());
    return TEMPLATES[key];
  }
  // decorate a vehicle body (procedural box or loaded GLB) with shared extras
  function buildTemplate(key, g) {
    {
      var bbV = new THREE.Box3().setFromObject(g); // body-only bounds (pre-decoration)
      var tr = TRAIL[key];
      if (tr) {
        // slim light streak, not geometry: low height + soft opacity
        var geo = new THREE.PlaneGeometry(tr.len, 0.55);
        geo.rotateY(Math.PI / 2); // plane local +x -> world -z (car forward)
        var mat = new THREE.MeshBasicMaterial({
          map: trailTexture(), color: tr.color, transparent: true, opacity: 0.7,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        var ribbon = new THREE.Mesh(geo, mat);
        ribbon.position.set(0, 0.75, VEHICLES[key].len / 2 + tr.len / 2 - 0.6);
        g.add(ribbon);
      }
      // headlight beam on the road ahead + hazard blinkers (4-wheelers only)
      if (key !== 'dns' && key !== 'arp') {
        if (!ECO) {
          var beam = new THREE.Mesh(beamGeometry(), beamMaterial());
          beam.position.set(0, 0.05, -(VEHICLES[key].len / 2 + 4.6));
          beam.renderOrder = 1;
          g.add(beam);
        }
        if (!MAT.amber) MAT.amber = new THREE.MeshBasicMaterial({ color: 0xffb340 });
        [-0.95, 0.95].forEach(function (hx) {
          var hz = box(g, 0.3, 0.22, 0.1, MAT.amber, hx, 0.9, VEHICLES[key].len / 2 + 0.02);
          hz.name = 'hz';
          hz.visible = false;
        });
      }
      var bb = new THREE.Box3().setFromObject(g);
      // soft blob shadow grounds the vehicle on the asphalt
      if (!MAT.blobShadow) MAT.blobShadow = new THREE.MeshBasicMaterial({
        map: radialTex('rgba(0,0,0,0.42)'), transparent: true, depthWrite: false
      });
      if (!_blobGeo) { _blobGeo = new THREE.PlaneGeometry(1, 1); _blobGeo.rotateX(-Math.PI / 2); }
      var blob = new THREE.Mesh(_blobGeo, MAT.blobShadow);
      blob.scale.set((bbV.max.x - bbV.min.x) * 1.5, 1, VEHICLES[key].len * 1.25);
      blob.position.y = 0.02;
      blob.renderOrder = 1;
      g.add(blob);
      return { group: g, h: bb.max.y };
    }
  }
  var _blobGeo = null;

  // shared headlight beam (one geometry + one material for every car)
  var _beamGeo = null, _beamMat = null;
  function beamGeometry() {
    if (!_beamGeo) { _beamGeo = new THREE.PlaneGeometry(4.6, 9.5); _beamGeo.rotateX(-Math.PI / 2); }
    return _beamGeo;
  }
  function beamMaterial() {
    if (!_beamMat) {
      var c = document.createElement('canvas'); c.width = 32; c.height = 64;
      var g = c.getContext('2d');
      var grad = g.createLinearGradient(0, 64, 0, 0);
      grad.addColorStop(0, 'rgba(255,242,196,0.32)'); grad.addColorStop(1, 'rgba(255,242,196,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 32, 64);
      _beamMat = new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
    }
    return _beamMat;
  }

  loadVehicleModels(); // CC0 GLB vehicles (Kenney car kit) swap in when fetched

  // every vehicle is labeled: packets without an owning app (system resolver
  // lookups, kernel traffic, unattributed flows) carry a protocol badge in
  // their legend color instead of an app logo
  var _badgeMats = {};
  function protoBadge(proto) {
    if (!_badgeMats[proto]) {
      var d = VEHICLES[proto] || VEHICLES.other;
      var label = PROTO_LABEL[proto] || '?';
      var c = document.createElement('canvas'); c.width = 96; c.height = 96;
      var g = c.getContext('2d');
      g.fillStyle = d.css;
      g.beginPath();
      if (g.roundRect) { g.roundRect(6, 6, 84, 84, 18); g.fill(); }
      else g.fillRect(6, 6, 84, 84);
      g.fillStyle = '#10141c';
      g.font = 'bold ' + (label.length > 4 ? 24 : 30) + 'px Consolas, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 48, 50);
      _badgeMats[proto] = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true });
    }
    return new THREE.Sprite(_badgeMats[proto]);
  }

  // app icon sprite cache
  var iconTex = {};
  function iconSprite(key) {
    if (!iconTex[key]) {
      var t = new THREE.TextureLoader().load('/icon/' + key + '.png');
      iconTex[key] = new THREE.SpriteMaterial({ map: t, transparent: true });
    }
    var s = new THREE.Sprite(iconTex[key]);
    s.scale.set(1.9, 1.9, 1);
    return s;
  }

  // cargo crates: what's "in transit" (size/app heuristic), shown on freight vehicles
  var CARGO_COLOR = { media: 0xff4fd8, audio: 0x4fd2ff, data: 0xffb347, text: 0xbfd4ff };
  var CARGO_MOUNT = { https: { y: 3.2, z: 0.5 }, http: { y: 3.45, z: 1.2 }, udp: { y: 2.6, z: 0 } };
  var cargoGeo = null, cargoMats = {};
  function addCargo(g, proto, cargo) {
    var mount = CARGO_MOUNT[proto];
    if (!mount || !CARGO_COLOR[cargo]) return;
    if (!cargoGeo) cargoGeo = new THREE.BoxGeometry(1.3, 0.45, 1.9);
    if (!cargoMats[cargo]) cargoMats[cargo] = new THREE.MeshBasicMaterial({ color: CARGO_COLOR[cargo] });
    var m = new THREE.Mesh(cargoGeo, cargoMats[cargo]);
    m.position.set(0, mount.y, mount.z);
    g.add(m);
  }

  // elevated freight line behind the left buildings — a train crosses on
  // bandwidth spikes, length scales with the burst
  var train = null, trainCooldownUntil = 0;
  (function freightTrack() {
    var railMat = new THREE.MeshLambertMaterial({ color: 0x1c2336 });
    var rail = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, ROAD_LEN + 80), railMat);
    rail.position.set(-46, 6.6, (Z0 + Z1) / 2); scene.add(rail);
    var glow = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, ROAD_LEN + 80), neonMat);
    glow.position.set(-44.7, 6.9, (Z0 + Z1) / 2); scene.add(glow);
    nightGlow.push(glow);
    for (var pz = Z0 - 30; pz < Z1 + 40; pz += 42) {
      var py = new THREE.Mesh(new THREE.BoxGeometry(1.3, 6.6, 1.3), poleMat);
      py.position.set(-46, 3.3, pz); scene.add(py);
    }
  })();
  var trainWinTex = null;
  function trainBanner(mbps) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 96; // 2x
    var g = c.getContext('2d');
    g.scale(2, 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 24px Consolas, monospace';
    g.shadowColor = '#2ee6e0'; g.shadowBlur = 12;
    g.fillStyle = '#c8fffc';
    g.fillText(mbps ? '⚡ ' + Math.round(mbps) + ' Mb/s BURST' : '⚡ BANDWIDTH SPIKE', 128, 24);
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    s.scale.set(13, 2.4, 1);
    return s;
  }
  function spawnTrain(nCars, mbps) {
    if (train) return;
    if (!trainWinTex) {
      var c = document.createElement('canvas'); c.width = 64; c.height = 16;
      var g = c.getContext('2d');
      g.fillStyle = '#10141e'; g.fillRect(0, 0, 64, 16);
      g.fillStyle = '#f0d8a0';
      for (var wx = 3; wx < 62; wx += 7) g.fillRect(wx, 5, 4, 6);
      trainWinTex = new THREE.CanvasTexture(c);
    }
    var grp = new THREE.Group();
    var bodyMat = new THREE.MeshLambertMaterial({ color: 0x2a3148 });
    var winMat = new THREE.MeshBasicMaterial({ map: trainWinTex });
    var loco = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.8, 7), bodyMat);
    loco.position.set(0, 1.6, -3.5); grp.add(loco);
    var headlight = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.15), MAT.head);
    headlight.position.set(0, 1.4, -7.05); grp.add(headlight);
    var hglow = new THREE.Sprite(new THREE.SpriteMaterial({ // visible from afar at night
      map: radialTex('rgba(255,244,200,0.8)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    hglow.scale.set(4.5, 3, 1);
    hglow.position.set(0, 1.4, -7.4);
    grp.add(hglow);
    var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 6.4), neonMat);
    stripe.position.set(-1.26, 2.2, -3.5); grp.add(stripe);
    for (var i = 0; i < nCars; i++) {
      var car = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.4, 8), bodyMat);
      car.position.set(0, 1.5, 5 + i * 9);
      grp.add(car);
      [-1.16, 1.16].forEach(function (sx) {
        var win = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 1.0), winMat);
        win.position.set(sx, 1.9, 5 + i * 9);
        win.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
        grp.add(win);
      });
    }
    var banner = trainBanner(mbps); // why this train is crossing
    banner.position.set(0, 5.6, -3.5);
    grp.add(banner);
    var len = 8 + nCars * 9;
    grp.position.set(-46, 6.85, Z1 + 30);
    scene.add(grp);
    train = { grp: grp, len: len, speed: 36 };
  }

  // power lines along both roadsides: long-lived sockets (websockets, push
  // channels) travel as electric pulses on the wires
  var wirePulses = [], WIRE_Y = 12.0, WIRE_XS = [-25.8, 25.8];
  (function powerLines() {
    var wireMat = new THREE.MeshLambertMaterial({ color: 0x1a2230 });
    WIRE_XS.forEach(function (wx) {
      for (var pz = Z0; pz < Z1 + 30; pz += 60) {
        var pole = new THREE.Mesh(new THREE.BoxGeometry(0.3, WIRE_Y, 0.3), poleMat);
        pole.position.set(wx, WIRE_Y / 2, pz); scene.add(pole);
        var arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.18), poleMat);
        arm.position.set(wx, WIRE_Y - 0.4, pz); scene.add(arm);
      }
      [-0.95, 0.95].forEach(function (ox) {
        var wire = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, ROAD_LEN + 60), wireMat);
        wire.position.set(wx + ox, WIRE_Y - 0.55, (Z0 + Z1) / 2); scene.add(wire);
      });
    });
  })();
  // kept deliberately subtle: at most one faint pulse every ~2s per direction,
  // representing "a long-lived socket is streaming" rather than per-packet noise
  var pulseMat = null, _lastPulse = { 'in': 0, out: 0 };
  function spawnPulse(dirIn, icon) {
    var key = dirIn ? 'in' : 'out';
    var nowMs = performance.now();
    if (wirePulses.length >= 4 || nowMs - _lastPulse[key] < 2000) return;
    _lastPulse[key] = nowMs;
    if (!pulseMat) pulseMat = new THREE.SpriteMaterial({
      map: radialTex('rgba(140,235,255,0.55)'), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var grp = new THREE.Group();
    var s = new THREE.Sprite(pulseMat);
    s.scale.set(1.8, 1.0, 1);
    grp.add(s);
    if (icon) { // the socket's app logo rides the wire with its pulse
      var ic = iconSprite(icon);
      ic.scale.setScalar(1.1);
      ic.position.y = 1.1;
      grp.add(ic);
    }
    var x = (dirIn ? WIRE_XS[0] : WIRE_XS[1]) + (Math.random() < 0.5 ? -0.95 : 0.95);
    grp.position.set(x, WIRE_Y - 0.55, dirIn ? Z0 : Z1);
    scene.add(grp);
    wirePulses.push({ s: grp, dir: dirIn ? 1 : -1 });
  }

  // app city: active applications rise as towers behind the freight line —
  // more traffic, taller tower (uses the decaying iconBytes accumulator)
  var appCity = [], APPCITY_X = -72;
  function appTower(key) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 320; // 2x for crisp text
    var ctx = c.getContext('2d');
    ctx.scale(2, 2);
    var tex = new THREE.CanvasTexture(c);
    var body = bTex[appCity.length % bTex.length].clone();
    body.wrapS = body.wrapT = THREE.RepeatWrapping;
    body.needsUpdate = true;
    var bodyDay = bTexDay[appCity.length % bTexDay.length].clone();
    bodyDay.wrapS = bodyDay.wrapT = THREE.RepeatWrapping;
    bodyDay.needsUpdate = true;
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(11, 1, 11),
      new THREE.MeshBasicMaterial({ map: envDayW > 0.5 ? bodyDay : body }));
    var plate = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 9.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    plate.rotation.y = Math.PI / 2; // face the highway
    var grp = new THREE.Group();
    grp.add(mesh); grp.add(plate);
    grp.position.set(APPCITY_X, 0, -28 - appCity.length * 17);
    scene.add(grp);
    var t = { key: key, grp: grp, mesh: mesh, body: body, bodyDay: bodyDay, plate: plate, ctx: ctx, tex: tex, cur: 6, target: 10 };
    appCity.push(t);
    return t;
  }
  function redrawTowerPlate(t) {
    var g = t.ctx;
    g.clearRect(0, 0, 128, 160);
    g.fillStyle = 'rgba(7,13,24,0.92)'; g.fillRect(0, 0, 128, 160);
    g.strokeStyle = '#57b8e8'; g.lineWidth = 4; g.strokeRect(3, 3, 122, 154);
    var img = bbImgCache[t.key];
    if (!img) { img = bbImgCache[t.key] = new Image(); img.src = '/icon/' + t.key + '.png'; img.onload = function () { redrawTowerPlate(t); }; }
    if (img.complete && img.naturalWidth) g.drawImage(img, 32, 18, 64, 64);
    g.font = 'bold 17px Consolas, monospace'; g.textAlign = 'center'; g.fillStyle = '#c8d6e5';
    var label = t.key.length > 12 ? t.key.slice(0, 11) + '…' : t.key;
    g.fillText(label, 64, 116);
    g.fillStyle = '#4fd2ff'; g.font = '14px Consolas, monospace';
    g.fillText(fmtBytes(iconBytes[t.key] || 0), 64, 140);
    t.tex.needsUpdate = true;
  }
  function updateAppCity() {
    var keys = Object.keys(iconBytes).sort(function (a, b) { return iconBytes[b] - iconBytes[a]; }).slice(0, 8);
    var max = keys.length ? iconBytes[keys[0]] : 1;
    keys.forEach(function (k) {
      var t = null;
      for (var i = 0; i < appCity.length; i++) if (appCity[i].key === k) { t = appCity[i]; break; }
      if (!t && appCity.length < 8) t = appTower(k);
      else if (!t) { // reuse the shortest tower for the newcomer
        t = appCity.reduce(function (a, b) { return a.cur < b.cur ? a : b; });
        t.key = k;
      }
      t.target = 10 + 52 * (iconBytes[k] / max);
      redrawTowerPlate(t);
    });
    appCity.forEach(function (t) { if (keys.indexOf(t.key) < 0) t.target = 6; });
  }
  setInterval(updateAppCity, 3000);

  // -------------------------------- utilities district (the machine itself)
  // CPU = power plant (smokestacks work harder under load), RAM = storage
  // tank (glowing fill level), DISK = silo (fill % + dock LED on I/O),
  // GPU = arena (neon ring spins and brightens with load)
  var UTIL_X = 68;
  var sysStat = { cpu: 0, gpu: -1, ramPct: 0, ramTxt: '—', disk: 0, io: 0, ioTxt: 'idle' };
  var plantSmokeAt = 0;
  var utilDistrict = (function () {
    function plate(parentY, z) {
      var c = document.createElement('canvas'); c.width = 384; c.height = 224; // 2x for crisp text
      var ctx = c.getContext('2d'); ctx.scale(2, 2);
      var tex = new THREE.CanvasTexture(c);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 5.5),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      m.rotation.y = -Math.PI / 2; // face the highway from the right bank
      m.position.set(UTIL_X - 1.5, parentY, z);
      scene.add(m);
      return { ctx: ctx, tex: tex };
    }
    function district(tex) {
      var t2 = tex.clone(); t2.wrapS = t2.wrapT = THREE.RepeatWrapping; t2.needsUpdate = true;
      return t2;
    }
    // CPU power plant
    var pTexN = district(bTex[1]), pTexD = district(bTexDay[1]);
    var pMat = new THREE.MeshBasicMaterial({ map: pTexN });
    buildingsList.push({ mat: pMat, night: pTexN, day: pTexD });
    var hall = new THREE.Mesh(new THREE.BoxGeometry(13, 10, 13), pMat);
    hall.position.set(UTIL_X, 5, -42); scene.add(hall);
    [-3.4, 3.4].forEach(function (sx) {
      var stack = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.5, 13, 10), poleMat);
      stack.position.set(UTIL_X + sx, 15.5, -42); scene.add(stack);
      var lip = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 2.4), neonMat);
      lip.position.set(UTIL_X + sx, 22.2, -42); scene.add(lip);
      nightGlow.push(lip);
    });
    // RAM storage tank
    var shell = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 15, 18, 1, true),
      new THREE.MeshLambertMaterial({ color: 0x222c40, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    shell.position.set(UTIL_X, 7.5, -72); scene.add(shell);
    var ramFill = new THREE.Mesh(new THREE.CylinderGeometry(4.9, 4.9, 14, 18),
      new THREE.MeshBasicMaterial({ color: 0x4fd2ff }));
    ramFill.position.set(UTIL_X, 0.4, -72); ramFill.scale.y = 0.04; scene.add(ramFill);
    // DISK silo
    var silo = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 13, 16),
      new THREE.MeshLambertMaterial({ color: 0x2b3348 }));
    silo.position.set(UTIL_X, 6.5, -102); scene.add(silo);
    var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 4.6, 2.6, 16),
      new THREE.MeshLambertMaterial({ color: 0x39425c }));
    cap.position.set(UTIL_X, 14.3, -102); scene.add(cap);
    var diskLed = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    diskLed.position.set(UTIL_X, 16.4, -102); scene.add(diskLed);
    // GPU arena
    var arena = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 9.5, 5, 20),
      new THREE.MeshLambertMaterial({ color: 0x252e44 }));
    arena.position.set(UTIL_X, 2.5, -134); scene.add(arena);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(8.2, 0.32, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x9a5cff, transparent: true, opacity: 0.85 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(UTIL_X, 5.15, -134); scene.add(ring); // hugs the arena rim
    for (var rm = 0; rm < 3; rm++) { // markers make the spin visible
      var mk = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xd8b4ff }));
      var ra = rm / 3 * Math.PI * 2;
      mk.position.set(Math.cos(ra) * 8.2, Math.sin(ra) * 8.2, 0);
      ring.add(mk);
    }
    return {
      plates: { cpu: plate(15, -42), ram: plate(19.5, -72), disk: plate(20.5, -102), gpu: plate(12, -134) },
      ramFill: ramFill, diskLed: diskLed, ring: ring
    };
  })();
  function redrawUtilPlates() {
    var P = utilDistrict.plates;
    function head(p, title, color, big, sub, frac) {
      var g = p.ctx;
      g.clearRect(0, 0, 192, 112);
      g.fillStyle = 'rgba(7,13,24,0.92)'; g.fillRect(0, 0, 192, 112);
      g.strokeStyle = color; g.lineWidth = 3; g.strokeRect(2, 2, 188, 108);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.font = 'bold 17px Consolas, monospace'; g.fillStyle = color;
      g.fillText(title, 12, 26);
      g.font = 'bold 34px Consolas, monospace'; g.fillStyle = '#e8f1fa';
      g.fillText(big, 12, 66);
      g.font = '14px Consolas, monospace'; g.fillStyle = '#8aa3bd';
      g.fillText(sub, 12, 88);
      g.fillStyle = '#1d2940'; g.fillRect(12, 96, 168, 8);
      g.fillStyle = color; g.fillRect(12, 96, Math.max(4, 168 * Math.min(1, frac)), 8);
      p.tex.needsUpdate = true;
    }
    head(P.cpu, 'CPU PLANT', '#ff8a5c', Math.round(sysStat.cpu) + '%', 'processor load', sysStat.cpu / 100);
    head(P.ram, 'RAM TANK', '#4fd2ff', Math.round(sysStat.ramPct) + '%', sysStat.ramTxt, sysStat.ramPct / 100);
    head(P.disk, 'DISK SILO', '#ffb347', Math.round(sysStat.disk) + '% full', sysStat.ioTxt, sysStat.disk / 100);
    head(P.gpu, 'GPU ARENA', '#9a5cff', sysStat.gpu < 0 ? 'n/a' : Math.round(sysStat.gpu) + '%', '3d engine load', Math.max(0, sysStat.gpu) / 100);
  }
  redrawUtilPlates();

  // -------------------------- city streets + commuter shuttles
  // both districts get a street grid that feeds the highway; courier cars
  // visibly leave their app's tower, drive the avenue, and merge at the
  // interchange (and arrive back the same way)
  var streetMat = new THREE.MeshLambertMaterial({ color: 0x111522 });
  var streetDashMat = new THREE.MeshBasicMaterial({ color: 0x39435c });
  function street(cx, cz, w, len, alongZ) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(alongZ ? w : len, alongZ ? len : w), streetMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0.006, cz);
    scene.add(m);
    var dashCount = Math.floor(len / 9);
    for (var di2 = 0; di2 < dashCount; di2++) {
      var dash = new THREE.Mesh(new THREE.PlaneGeometry(alongZ ? 0.25 : 3, alongZ ? 3 : 0.25), streetDashMat);
      dash.rotation.x = -Math.PI / 2;
      var o = -len / 2 + 4.5 + di2 * 9;
      dash.position.set(alongZ ? cx : cx + o, 0.012, alongZ ? cz + o : cz);
      scene.add(dash);
    }
  }
  // back avenues between the building rows + cross streets = connected grid
  [-76, 76].forEach(function (ax) { street(ax, (Z0 + Z1) / 2, 5, ROAD_LEN + 40, true); });
  [-300, -230, -190, 40, 100, 150].forEach(function (cz2) {
    [-1, 1].forEach(function (sid) { street(sid * 82, cz2, 4.5, 60, false); });
  });
  street(-58, -89, 5.5, 152, true);   // app-city avenue
  for (var sd = 0; sd < 8; sd++) street(-65, -28 - sd * 17, 4, 15, false); // tower driveways
  street(-38, -89, 5, 42, false);     // interchange ramp — runs under the highway shoulder
  street(-72, -13, 4.5, 30, false);   // avenue end caps into the back blocks
  street(-72, -165, 4.5, 30, false);
  street(58, -88, 5.5, 122, true);    // utilities avenue
  [-42, -72, -102, -134].forEach(function (uz) { street(63.5, uz, 4, 12, false); });
  street(38, -88, 5, 42, false);      // utilities ramp to the highway shoulder
  street(72, -27, 4.5, 30, false);    // avenue end caps
  street(72, -149, 4.5, 30, false);

  var shuttles = [], lastShuttleAt = 0, lastExitAt = 0;
  function towerFor(key) {
    for (var ti2 = 0; ti2 < appCity.length; ti2++) if (appCity[ti2].key === key) return appCity[ti2];
    return null;
  }
  // smooth curved paths (no sharp right-angle turns): every surface-street
  // route is a Catmull-Rom spline and cars steer along the tangent
  function pathCurve(pts) {
    var c = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
    c.arcLengthDivisions = 80;
    return { c: c, len: c.getLength() };
  }
  // the interchange flyover: an elevated sweeping ramp off the IN roadway
  // down to the app-city avenue (deliveries ride over the shoulder, not
  // through a 90-degree corner)
  var EXIT_PTS = [
    new THREE.Vector3(-29, 1.2, -102),
    new THREE.Vector3(-35, 3.4, -93),
    new THREE.Vector3(-44, 4.2, -88),
    new THREE.Vector3(-52, 2.6, -86),
    new THREE.Vector3(-57, 0.6, -82),
    new THREE.Vector3(-58, 0, -72)
  ];
  function roadRibbon(curve, width, mat, segs) {
    var pos = [], idx = [];
    for (var i = 0; i <= segs; i++) {
      var t = i / segs;
      var p = curve.getPointAt(t);
      var tg = curve.getTangentAt(t);
      var nx = -tg.z, nz = tg.x;
      var nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl; nz /= nl;
      pos.push(p.x + nx * width / 2, p.y + 0.05, p.z + nz * width / 2,
               p.x - nx * width / 2, p.y + 0.05, p.z - nz * width / 2);
      if (i < segs) { var a2 = i * 2; idx.push(a2, a2 + 1, a2 + 2, a2 + 1, a2 + 3, a2 + 2); }
    }
    var rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    rg.setIndex(idx);
    rg.computeVertexNormals();
    return new THREE.Mesh(rg, mat);
  }
  (function flyover() {
    var pts = [new THREE.Vector3(-26.5, 0, -114)].concat(EXIT_PTS);
    var rc = pathCurve(pts);
    scene.add(roadRibbon(rc.c, 6.2, new THREE.MeshLambertMaterial({ color: 0x161b29, side: THREE.DoubleSide }), 40));
    [0.3, 0.5, 0.7].forEach(function (t) { // support pylons under the deck
      var p = rc.c.getPointAt(t);
      if (p.y < 0.8) return;
      var py = new THREE.Mesh(new THREE.BoxGeometry(1.2, p.y, 1.2), poleMat);
      py.position.set(p.x, p.y / 2, p.z);
      scene.add(py);
    });
  })();
  function spawnShuttle() {
    if (!TEMPLATES.other || !appCity.length || shuttles.length >= 6) return;
    var t = appCity[(Math.random() * appCity.length) | 0];
    var tz = t.grp.position.z;
    var leaving = Math.random() < 0.5;
    var pts = [ // tower driveway -> avenue -> interchange -> onto the highway
      new THREE.Vector3(-69, 0, tz),
      new THREE.Vector3(-58, 0, tz),
      new THREE.Vector3(-58, 0, -89),
      new THREE.Vector3(-27, 0, -89) // merges at the highway shoulder
    ];
    if (!leaving) pts.reverse();
    var g = TEMPLATES.other.group.clone();
    g.scale.setScalar(0.78);
    if (t.key) {
      var ic = iconSprite(t.key);
      ic.position.set(0, 3.0, 0);
      ic.scale.setScalar(1.6);
      g.add(ic);
    }
    g.position.copy(pts[0]);
    scene.add(g);
    shuttles.push({ g: g, path: pathCurve(pts), s: 0, speed: 8.5 });
  }
  function stepShuttles(dt) {
    for (var i = shuttles.length - 1; i >= 0; i--) {
      var s = shuttles[i];
      s.s += s.speed * dt;
      if (s.s >= s.path.len) { scene.remove(s.g); shuttles.splice(i, 1); continue; }
      var t = s.s / s.path.len;
      s.g.position.copy(s.path.c.getPointAt(t));
      var tg = s.path.c.getTangentAt(t);
      s.g.rotation.y = Math.atan2(tg.x, tg.z) + Math.PI; // model forward is -z
    }
  }

  // skyline = running processes: tallest buildings are the biggest RAM users,
  // hot (CPU-busy) processes get brighter windows, top 5 get roof name signs
  function roofLabel(name) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 96; // 2x
    var g = c.getContext('2d');
    g.scale(2, 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 26px Consolas, monospace';
    g.shadowColor = '#57b8e8'; g.shadowBlur = 10;
    g.fillStyle = '#bfe8ff';
    g.fillText(name.slice(0, 16), 128, 24);
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    s.scale.set(15, 2.8, 1);
    return s;
  }
  function handleProcs(list) { // [{n, ram, cpu}] sorted by ram desc
    var free = [];
    for (var i = 0; i < procBuildings.length; i++) if (!procBuildings[i].pinned) free.push(procBuildings[i]);
    var maxRam = list.length ? list[0].ram : 1;
    for (var j = 0; j < free.length; j++) {
      var rec = free[j], p = list[j];
      if (p) {
        rec.target = 13 + 64 * (p.ram / maxRam);
        var bright = 1 + Math.min(1.4, (p.cpu || 0) / 45); // hot proc = bright windows
        rec.lit.color.setScalar(rec.jit * bright);
        rec.shade.color.setScalar(rec.jit * bright * 0.66);
        if (j < 5) {
          if (rec.labelName !== p.n) {
            if (rec.label) { rec.mesh.parent.remove(rec.label); rec.label.material.map.dispose(); rec.label.material.dispose(); }
            rec.label = roofLabel(p.n);
            rec.label.position.set(rec.mesh.position.x, rec.cur + 4, rec.mesh.position.z);
            scene.add(rec.label);
            rec.labelName = p.n;
          }
        } else if (rec.label) {
          scene.remove(rec.label); rec.label.material.map.dispose(); rec.label.material.dispose();
          rec.label = null; rec.labelName = null;
        }
      } else {
        rec.target = 9; // no process for this lot: idle land
        rec.lit.color.setScalar(rec.jit);
        rec.shade.color.setScalar(rec.jit * 0.66);
      }
    }
  }

  // surveillance drones hover over the city — one per ~8 connected servers
  var drones = [];
  function makeDrone() {
    var g = new THREE.Group();
    box(g, 0.9, 0.25, 0.9, MAT.dark, 0, 0, 0);
    [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].forEach(function (o) {
      box(g, 0.5, 0.06, 0.5, MAT.tire, o[0], 0.16, o[1]);
    });
    var led = box(g, 0.16, 0.16, 0.16, MAT.red, 0, -0.18, 0);
    g.scale.setScalar(1.4); // readable at distance
    g.position.set(-25 + Math.random() * 50, 22 + Math.random() * 12, -130 + Math.random() * 150);
    scene.add(g);
    return { g: g, t: Math.random() * 100, cx: g.position.x, cy: g.position.y, cz: g.position.z, led: led, badge: null, iconKey: null };
  }
  function setDroneCount(n) {
    while (drones.length < n) drones.push(makeDrone());
    while (drones.length > n) { var d = drones.pop(); scene.remove(d.g); }
  }

  // airplane: a big download is a landing approach over the highway,
  // a big upload is a takeoff (triggered from sustained bandwidth in handleStats)
  var plane = null, planeCooldownUntil = 0;
  function spawnPlane(landing) {
    if (plane) return;
    var g = new THREE.Group();
    var body = new THREE.MeshLambertMaterial({ color: 0xd8e0ec, emissive: 0x8090b0, emissiveIntensity: 0.3 });
    box(g, 1.7, 1.7, 13, body, 0, 0, 0);                 // fuselage
    box(g, 15, 0.28, 2.8, body, 0, 0.1, 0.5);            // wings
    box(g, 5.5, 0.24, 1.7, body, 0, 1.3, 5.6);           // tail wing
    box(g, 0.24, 2.0, 1.7, body, 0, 1.4, 5.6);           // fin
    box(g, 1.2, 0.55, 0.3, MAT.head, 0, -0.25, -6.55);   // nose light
    var wl = box(g, 0.32, 0.32, 0.32, MAT.red, -7.5, 0.1, 0.5);
    var wr = box(g, 0.32, 0.32, 0.32, new THREE.MeshBasicMaterial({ color: 0x35ff70 }), 7.5, 0.1, 0.5);
    // landing-light halo so the plane reads against a night sky
    var nose = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex('rgba(255,244,210,0.85)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    nose.scale.set(5, 5, 1);
    nose.position.set(0, -0.3, -6.9);
    g.add(nose);
    g.scale.setScalar(1.5);
    scene.add(g);
    plane = { g: g, t: 0, landing: landing, wl: wl, wr: wr, dur: 16 };
  }
  function stepPlane(dt, now) {
    if (!plane) return;
    plane.t += dt;
    var p = Math.min(1, plane.t / plane.dur);
    if (plane.landing) { // glide in over the highway toward the camera
      plane.g.position.set(-6, 13 + 92 * Math.pow(1 - p, 1.7), -480 + 600 * p);
      plane.g.rotation.set(0.10 * (1 - p), Math.PI, 0); // nose-up flare, flying +z
    } else {            // takeoff: away from the camera, climbing out
      plane.g.position.set(6, 13 + 92 * Math.pow(p, 1.7), 120 - 600 * p);
      plane.g.rotation.set(-0.12 * p, 0, 0);
    }
    var strobe = Math.sin(now * 0.02) > 0.6; // wing strobes
    plane.wl.visible = strobe; plane.wr.visible = !strobe;
    if (p >= 1) { scene.remove(plane.g); plane = null; }
  }

  // -------------------------------------------------------- accidents
  // real network faults become crashes: dropped/errored packets (adapter
  // counters), ping timeouts, and duplicate packets each wreck a vehicle
  var ACC_LABEL = { drop: 'PACKETS DROPPED', loss: 'PING TIMEOUT', dup: 'DUPLICATE PACKET' };
  var crashes = [], smokes = [], lastAcc = 0, smokeBase = null;
  function accLabelSprite(text) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 96; // 2x for crisp text
    var g = c.getContext('2d');
    g.scale(2, 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 26px Consolas, monospace';
    g.shadowColor = '#ff5d6c'; g.shadowBlur = 12;
    g.fillStyle = '#ffd7db';
    g.fillText('⚠ ' + text, 128, 24);
    var s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false
    }));
    s.scale.set(9, 1.7, 1);
    return s;
  }
  function spawnSmoke(pos) {
    if (!smokeBase) smokeBase = new THREE.SpriteMaterial({
      map: radialTex('rgba(58,60,68,0.7)'), transparent: true, depthWrite: false, color: 0x3a3e46
    });
    var s = new THREE.Sprite(smokeBase.clone());
    s.position.set(pos.x + (Math.random() - 0.5), 1.6, pos.z + (Math.random() - 0.5) * 2);
    s.scale.setScalar(1.6);
    scene.add(s);
    smokes.push({ s: s, t: 0 });
  }
  var _flashMat = null;
  function impactFlash(pos) { // hot white-orange burst at the moment of the wreck
    if (!_flashMat) _flashMat = new THREE.SpriteMaterial({
      map: radialTex('rgba(255,200,120,0.95)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var s = new THREE.Sprite(_flashMat.clone());
    s.position.set(pos.x, 1.8, pos.z);
    s.scale.setScalar(3);
    scene.add(s);
    smokes.push({ s: s, t: 0, vy: 1, life: 0.5, grow: 16 });
  }
  function accident(kind, n) {
    var nowMs = performance.now();
    if (nowMs - lastAcc < 20000) return; // one wreck at a time, keep it special
    var cand = [];
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (!c.crashed && c.pkt.proto !== 'dns' && c.pkt.proto !== 'arp' &&
          c.group.position.z > -140 && c.group.position.z < 5) cand.push(c);
    }
    if (!cand.length) return;
    lastAcc = nowMs;
    var car = cand[(Math.random() * cand.length) | 0];
    car.crashed = true;
    car.crashT = nowMs;
    car.spin = (Math.random() < 0.5 ? 1 : -1) * (2.6 + Math.random() * 2);
    car.slide = (Math.random() < 0.5 ? -1 : 1) * 0.9; // stays inside its own lane
    impactFlash(car.group.position);
    var fire = new THREE.PointLight(0xff6a20, 2.2, 16);
    fire.position.set(car.group.position.x, 2.2, car.group.position.z);
    scene.add(fire);
    setTimeout(function () { scene.remove(fire); }, 4000);
    // skid marks from the lane to the resting spot
    if (!MAT.skid) MAT.skid = new THREE.MeshBasicMaterial({ color: 0x05070b, transparent: true, opacity: 0.55 });
    var lbl = accLabelSprite((ACC_LABEL[kind] || 'PACKET LOST') + (n > 1 ? ' ×' + Math.min(n, 999) : ''));
    lbl.position.set(0, car.h + 3.2, 0);
    car.group.add(lbl);
    var deb = [];
    [-0.5, 0.5].forEach(function (sx) { // skid streaks behind the wreck
      var sk = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 7), MAT.skid);
      sk.rotation.x = -Math.PI / 2;
      sk.rotation.z = car.slide * 0.18;
      sk.position.set(car.group.position.x + sx, 0.03, car.group.position.z - car.dir * 4);
      sk.renderOrder = 1;
      scene.add(sk);
      deb.push(sk);
    });
    for (var d = 0; d < Math.min(4, DEBRIS.length === 0 ? 0 : 3 + (Math.random() * 2 | 0)); d++) {
      var piece = DEBRIS[(Math.random() * DEBRIS.length) | 0].clone();
      piece.position.set(car.group.position.x + Math.random() * 5 - 2.5, 0.04,
                         car.group.position.z + Math.random() * 7 - 3.5);
      piece.rotation.y = Math.random() * Math.PI * 2;
      scene.add(piece);
      deb.push(piece);
    }
    crashes.push({ car: car, deb: deb, smokeAt: 0 });
    logAccident(kind, n);
  }
  function endCrash(entry) {
    entry.deb.forEach(function (d) { scene.remove(d); });
    removeCar(entry.car);
  }
  // ------------------------------------------------------------ traffic
  var cars = [];           // active vehicles
  var spawnQueue = [];     // packets waiting for lane space
  var carsRoot = new THREE.Group();
  scene.add(carsRoot);

  function spawnCar(pkt) {
    var def = VEHICLES[pkt.proto] || VEHICLES.other;
    var lanes = pkt.dir === 'in' ? lanesIn : lanesOut;
    // "in" drives toward camera (+z), spawns far; "out" drives away (-z), spawns near
    var dirSign = pkt.dir === 'in' ? 1 : -1;
    var startZ = pkt.dir === 'in' ? Z0 - 5 : Z1 + 5;

    // pick the lane with the most clearance ahead of the spawn point
    var lane = null, bestClear = -1;
    for (var i = 0; i < lanes.length; i++) {
      var L = lanes[i], clear = 1e9;
      if (L.closed) continue;
      for (var j = 0; j < L.cars.length; j++) {
        var d = (L.cars[j].group.position.z - startZ) * dirSign + 1e-6;
        if (d > -L.cars[j].len && d < clear) clear = d;
      }
      if (clear > bestClear) { bestClear = clear; lane = L; }
    }
    if (!lane || bestClear < def.len * 1.6 + 6) return false;

    var tpl = getTemplate(pkt.proto);
    var g = tpl.group.clone();
    addCargo(g, pkt.proto, pkt.cargo);
    // packet size -> vehicle size (uniform, so nothing deforms)
    var sz = 0.8 + Math.min(1, (pkt.bytes || 60) / 1500) * 0.5;
    g.scale.setScalar(sz);
    g.position.set(lane.x, 0, startZ);
    if (dirSign === 1) g.rotation.y = Math.PI; // face +z
    carsRoot.add(g);

    var tail = null, hz = [];
    for (var tc = 0; tc < g.children.length; tc++) {
      if (g.children[tc].name === 'tail') tail = g.children[tc];
      else if (g.children[tc].name === 'hz') hz.push(g.children[tc]);
    }
    var car = {
      group: g, lane: lane, dir: dirSign,
      speed: def.speed * lane.f * (0.92 + Math.random() * 0.16),
      len: def.len * sz, pkt: pkt, flashT: Math.random() * Math.PI,
      icon: null, h: tpl.h, tail: tail, hz: hz,
      brakeUntil: 0, brakeOn: false, stuckSince: 0
    };
    if (pkt.icon) {
      var s = iconSprite(pkt.icon);
      s.position.set(0, car.h + 1.7, 0);
      s.scale.setScalar(1.9 / sz); // keep icon size constant in world space
      g.add(s);
      car.icon = s;
    } else { // no app attribution: protocol badge so nothing rides unlabeled
      var sb = protoBadge(pkt.proto);
      sb.position.set(0, car.h + 1.5, 0);
      sb.scale.setScalar(1.25 / sz);
      g.add(sb);
      car.icon = sb;
    }
    lane.cars.push(car);
    cars.push(car);
    onRoadEl.textContent = cars.length;
    return true;
  }

  function removeCar(car) {
    carsRoot.remove(car.group);
    var li = car.lane.cars.indexOf(car); if (li >= 0) car.lane.cars.splice(li, 1);
    var ci = cars.indexOf(car); if (ci >= 0) cars.splice(ci, 1);
  }

  function step(dt, now) {
    // spawn from queue, a few per frame
    var budget = 3;
    while (budget-- > 0 && spawnQueue.length > 0 && cars.length < MAX_CARS) {
      if (spawnCar(spawnQueue[0])) spawnQueue.shift();
      else break; // all lanes blocked at spawn point; retry next frame
    }
    if (spawnQueue.length > 80) spawnQueue.splice(0, spawnQueue.length - 80);

    for (var i = cars.length - 1; i >= 0; i--) {
      var c = cars[i];
      if (c.crashed) { // spin out, slide to a stop, hazards + smoke, then clear
        var ct = (now - c.crashT) / 1000;
        if (ct < 0.9) {
          c.group.rotation.y += c.spin * dt;
          c.group.position.x += c.slide * dt;
          c.group.position.z += c.dir * 7 * (0.9 - ct) * dt;
        } else if (c.hz.length) {
          var hzOn = Math.sin(now * 0.012) > 0;
          c.hz.forEach(function (h3) { h3.visible = hzOn; });
          if (c.tail && !c.brakeOn) {
            c.brakeOn = true;
            c.tail.material = MAT.tailBright;
            c.tail.scale.set(1.35, 1.35, 1);
          }
        }
        continue;
      }
      var ahead = null, gap = 1e9;
      for (var j = 0; j < c.lane.cars.length; j++) {
        var o = c.lane.cars[j];
        if (o === c) continue;
        var d = (o.group.position.z - c.group.position.z) * c.dir;
        if (d > 0 && d < gap) { gap = d; ahead = o; }
      }
      var v = c.speed;
      var move = v * dt;
      if (ahead) {
        // bumper-to-bumper distance; never allow overlap (hard collision clamp)
        var minGap = (c.len + ahead.len) * 0.5 + 1.4;
        if (gap < minGap * 2.5) v = Math.min(v, ahead.speed); // ease off when closing
        move = Math.min(v * dt, Math.max(0, gap - minGap));
        if (move < c.speed * dt * 0.8) c.brakeUntil = now + 250; // braking
      }
      c.group.position.z += move * c.dir;

      if (c.tail) { // brake lights flare while the clamp is active
        var braking = now < c.brakeUntil;
        if (braking !== c.brakeOn) {
          c.brakeOn = braking;
          c.tail.material = braking ? MAT.tailBright : MAT.tail;
          c.tail.scale.set(braking ? 1.35 : 1, braking ? 1.35 : 1, 1);
          if (!braking) { c.stuckSince = 0; c.hz.forEach(function (h2) { h2.visible = false; }); }
        }
        if (braking) { // stuck in traffic >1.2s: hazard blinkers
          if (!c.stuckSince) c.stuckSince = now;
          if (c.hz.length && now - c.stuckSince > 1200) {
            var on2 = Math.sin(now * 0.012) > 0;
            c.hz.forEach(function (h2) { h2.visible = on2; });
          }
        }
      }

      if (c.pkt.proto === 'icmp') { // police lightbar flash
        c.flashT += dt * 9;
        var on = Math.sin(c.flashT) > 0;
        c.group.children.forEach(function (ch) {
          if (ch.name === 'flashR') ch.visible = on;
          else if (ch.name === 'flashB') ch.visible = !on;
        });
      }
      if (c.icon) c.icon.position.y = c.h + 1.9 + Math.sin(now * 0.0024 + c.flashT) * 0.12;

      if ((c.dir === 1 && c.group.position.z > Z1 + 60) || (c.dir === -1 && c.group.position.z < Z0 - 60))
        removeCar(c); // far onto the continuation slab, deep in the fog
    }
    if (train) {
      train.grp.position.z -= train.speed * dt;
      if (train.grp.position.z < Z0 - train.len - 40) {
        scene.remove(train.grp);
        train = null;
      }
    }

    stepPlane(dt, now);
    // delivery drones: shuttle between their app's tower and the highway,
    // nose pointed along the flight path (courier runs, not random hover)
    for (var dr = 0; dr < drones.length; dr++) {
      var dd = drones[dr];
      dd.t += dt;
      if (!dd.leg || dd.t > dd.leg.dur) {
        var tower = null;
        for (var ti = 0; ti < appCity.length; ti++)
          if (dd.iconKey && appCity[ti].key === dd.iconKey) { tower = appCity[ti]; break; }
        var tz = tower ? tower.grp.position.z : (-40 - dr * 18);
        dd.out = !dd.out;
        var dst = dd.out
          ? new THREE.Vector3(-8 + Math.random() * 16, 15 + Math.random() * 5, tz + (Math.random() * 36 - 18))
          : new THREE.Vector3(APPCITY_X + (Math.random() * 8 - 4), Math.max(20, tower ? tower.cur + 9 : 24), tz); // stay above the freight rail
        dd.leg = { from: dd.g.position.clone(), to: dst, dur: 5.5 + Math.random() * 3 };
        dd.t = 0;
      }
      var lk = Math.min(1, dd.t / dd.leg.dur);
      var le = lk < 0.5 ? 2 * lk * lk : 1 - Math.pow(-2 * lk + 2, 2) / 2;
      dd.g.position.lerpVectors(dd.leg.from, dd.leg.to, le);
      dd.g.position.y += Math.sin(dd.t * 4.5 + dr) * 0.08; // rotor wobble
      var hv = dd.leg.to.clone().sub(dd.leg.from);
      dd.g.rotation.y = Math.atan2(hv.x, hv.z);
      dd.led.visible = Math.sin((dd.t + dr) * 7) > 0;
    }

    // skyline towers grow/shrink toward their process's RAM share
    for (var pb = 0; pb < procBuildings.length; pb++) {
      var rb = procBuildings[pb];
      if (Math.abs(rb.cur - rb.target) > 0.1) {
        rb.cur += (rb.target - rb.cur) * Math.min(1, dt * 1.2);
        rb.mesh.scale.y = rb.cur;
        rb.mesh.position.y = rb.cur / 2 - 0.1;
        rb.night.repeat.set(Math.max(1, Math.round(rb.w / 14)), Math.max(1, Math.round(rb.cur / 26)));
        rb.day.repeat.copy(rb.night.repeat);
      }
      if (rb.label) rb.label.position.y = rb.cur + 4;
      if (rb.roof) rb.roof.position.y = rb.cur - 0.1;
    }

    // utilities district: plant smokes with CPU, tank fills with RAM,
    // silo LED blinks on disk I/O, arena ring spins with GPU
    if (sysStat.cpu > 3 && now - plantSmokeAt > Math.max(260, 2400 - sysStat.cpu * 22) && smokes.length < 26) {
      plantSmokeAt = now;
      var psx = Math.random() < 0.5 ? -3.4 : 3.4;
      if (!smokeBase) smokeBase = new THREE.SpriteMaterial({
        map: radialTex('rgba(200,205,215,0.5)'), transparent: true, depthWrite: false, color: 0x6a7078
      });
      var sp = new THREE.Sprite(smokeBase.clone());
      sp.position.set(UTIL_X + psx, 23, -42);
      sp.scale.setScalar(1.6);
      scene.add(sp);
      smokes.push({ s: sp, t: 0, vy: 3.4 });
    }
    // commuter shuttles between app towers and the highway interchange
    if (now - lastShuttleAt > 2800) { lastShuttleAt = now; spawnShuttle(); }
    stepShuttles(dt);

    var ramT = Math.max(0.04, sysStat.ramPct / 100);
    utilDistrict.ramFill.scale.y += (ramT - utilDistrict.ramFill.scale.y) * Math.min(1, dt * 2);
    utilDistrict.ramFill.position.y = 0.4 + 14 * utilDistrict.ramFill.scale.y / 2;
    utilDistrict.diskLed.visible = sysStat.io > 300000 ? Math.sin(now * (0.004 + Math.min(0.03, sysStat.io / 4e8))) > 0 : true;
    utilDistrict.ring.rotation.z += dt * (0.25 + Math.max(0, sysStat.gpu) / 100 * 3.5);
    utilDistrict.ring.material.opacity = 0.45 + Math.max(0, sysStat.gpu) / 100 * 0.5;

    // crash scenes: smoke plumes while wrecked, towed away after 10 s
    for (var cr = crashes.length - 1; cr >= 0; cr--) {
      var C = crashes[cr];
      var age = now - C.car.crashT;
      if (age > 600 && now - C.smokeAt > 420 && smokes.length < 14) {
        C.smokeAt = now;
        spawnSmoke(C.car.group.position);
      }
      if (age > 10000) { endCrash(C); crashes.splice(cr, 1); }
    }
    for (var sm = smokes.length - 1; sm >= 0; sm--) {
      var S = smokes[sm];
      var life = S.life || 1.7;
      S.t += dt;
      S.s.position.y += dt * (S.vy || 2.4);
      S.s.scale.setScalar(1.4 + S.t * (S.grow || 2.4));
      S.s.material.opacity = Math.max(0, 0.55 * (1 - S.t / life));
      if (S.t > life) { scene.remove(S.s); S.s.material.dispose(); smokes.splice(sm, 1); }
    }

    // electric pulses racing along the power lines
    for (var wp = wirePulses.length - 1; wp >= 0; wp--) {
      var pu = wirePulses[wp];
      pu.s.position.z += 110 * pu.dir * dt;
      if (pu.s.position.z > Z1 + 10 || pu.s.position.z < Z0 - 10) {
        scene.remove(pu.s);
        wirePulses.splice(wp, 1);
      }
    }

    // app towers grow/shrink toward their traffic share
    for (var at = 0; at < appCity.length; at++) {
      var t = appCity[at];
      if (Math.abs(t.cur - t.target) > 0.05) {
        t.cur += (t.target - t.cur) * Math.min(1, dt * 1.6);
        t.mesh.scale.y = t.cur;
        t.mesh.position.y = t.cur / 2;
        t.body.repeat.set(1, Math.max(1, Math.round(t.cur / 26)));
        t.bodyDay.repeat.copy(t.body.repeat);
        t.plate.position.y = t.cur + 3.2; // sits on the roofline, not floating
      }
    }

    onRoadEl.textContent = cars.length;
    laneController();
  }

  // ------------------------------------------------------------ HUD
  var badge = document.getElementById('badge');
  var ppsInEl = document.getElementById('ppsIn'), ppsOutEl = document.getElementById('ppsOut');
  var bpsInEl = document.getElementById('bpsIn'), bpsOutEl = document.getElementById('bpsOut');
  var onRoadEl = document.getElementById('onRoad'), pctEl = document.getElementById('pct');
  var logRows = document.getElementById('logRows');
  var pingEl = document.getElementById('ping'), linkEl = document.getElementById('link');
  var lanesEl = document.getElementById('lanesEl');
  var srvCountEl = document.getElementById('srvCount'), srvRows = document.getElementById('srvRows');

  function fmtBytes(n) {
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // legend
  (function () {
    var lg = document.getElementById('legend');
    Object.keys(VEHICLES).forEach(function (k) {
      var d = VEHICLES[k];
      var row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span class="dot" style="background:' + d.css + '"></span>' +
        '<span class="veh">' + d.veh + '</span><span class="proto">' + d.proto + '</span>';
      lg.appendChild(row);
    });
    var foot = document.createElement('div');
    foot.style.cssText = 'margin-top:9px;padding-top:7px;border-top:1px solid rgba(80,140,200,0.18);color:#5d738c;font-size:12px;line-height:1.6';
    foot.innerHTML =
      'vehicle size = packet size · ↓ in ↑ out<br>' +
      '⚡ wire pulse = live socket stream<br>' +
      '🚆 train = bandwidth spike<br>' +
      '🏙 tower height = app traffic<br>' +
      '💥 crash = packet drop / dup / timeout<br>' +
      '🛸 drone = top server courier (tower ⇄ highway)<br>' +
      '✈ landing = big download · takeoff = big upload<br>' +
      '🟨 DNS badge = system resolver lookup<br>' +
      '🏢 skyline = processes (height=RAM, bright=CPU)<br>' +
      '🏭 right bank = CPU plant · RAM tank · disk · GPU<br>' +
      '🚗 side streets = apps commuting to the highway';
    lg.appendChild(foot);
  })();

  var LOG_MAX = 13;
  function logPacket(p) {
    var d = VEHICLES[p.proto] || VEHICLES.other;
    var row = document.createElement('div'); row.className = 'row';
    var app = p.app
      ? '<span class="app">' + (p.icon ? '<img src="/icon/' + p.icon + '.png" alt="">' : '') + esc(p.app) + '</span>'
      : '<span class="app"></span>';
    row.innerHTML = '<span class="dot" style="background:' + d.css + '"></span>' +
      '<span class="proto">' + (p.dir === 'in' ? '↓' : '↑') + ' ' + PROTO_LABEL[p.proto] + '</span>' + app +
      '<span class="bytes">' + fmtBytes(p.bytes) + '</span>';
    logRows.insertBefore(row, logRows.firstChild);
    while (logRows.children.length > LOG_MAX) logRows.removeChild(logRows.lastChild);
    for (var i = 0; i < logRows.children.length; i++)
      logRows.children[i].classList.toggle('old', i >= 5);
  }
  function esc(s) { var d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  function logAccident(kind, n) {
    var row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<span class="dot" style="background:#ff5d6c"></span>' +
      '<span class="proto" style="color:#ff8a96">💥 ' + (kind === 'dup' ? 'DUP' : kind === 'loss' ? 'LOSS' : 'DROP') + '</span>' +
      '<span class="app" style="color:#c98a92">' + (ACC_LABEL[kind] || 'packet lost').toLowerCase() + '</span>' +
      '<span class="bytes" style="color:#ff8a96">' + (n > 1 ? '×' + Math.min(n, 999) : '') + '</span>';
    logRows.insertBefore(row, logRows.firstChild);
    while (logRows.children.length > LOG_MAX) logRows.removeChild(logRows.lastChild);
    for (var i = 0; i < logRows.children.length; i++)
      logRows.children[i].classList.toggle('old', i >= 5);
  }

  function setBadge(mode, source) {
    badge.classList.remove('demo', 'error');
    if (mode === 'live') badge.textContent = 'LIVE · ' + (source || 'pktmon @ any');
    else if (mode === 'demo') { badge.textContent = 'DEMO · synthetic'; badge.classList.add('demo'); }
    else if (mode === 'error') { badge.textContent = 'NO CAPTURE — run as admin'; badge.classList.add('error'); }
    else badge.textContent = 'STARTING';
  }

  // ------------------------------------------------------------ events
  function handlePkts(arr) {
    for (var i = 0; i < arr.length; i++) {
      spawnQueue.push(arr[i]);
      logPacket(arr[i]);
      if (arr[i].dest) destCounts[arr[i].dest] = (destCounts[arr[i].dest] || 0) + 1;
      if (arr[i].icon) iconBytes[arr[i].icon] = (iconBytes[arr[i].icon] || 0) + arr[i].bytes;
      if (arr[i].wire) spawnPulse(arr[i].dir === 'in', arr[i].icon);
    }
  }
  var bwEma = 0, dlEma = 0, upEma = 0;
  function handleStats(s) {
    ppsInEl.textContent = s.ppsIn;
    ppsOutEl.textContent = s.ppsOut;
    bpsInEl.textContent = fmtBytes(s.bpsIn);
    bpsOutEl.textContent = fmtBytes(s.bpsOut);
    pctEl.textContent = s.pct + '%';
    setBadge(s.mode, s.source);

    // ping + link readout
    lastPing = typeof s.ping === 'number' ? s.ping : -1;
    if (lastPing >= 0) {
      pingEl.textContent = lastPing + ' ms';
      pingEl.className = lastPing < 35 ? 'good' : (lastPing < 90 ? 'warn' : 'bad');
    } else { pingEl.textContent = 'n/a'; pingEl.className = 'bad'; }
    var mbps = (s.bpsIn + s.bpsOut) * 8 / 1e6;
    var link = s.link >= 1e9 ? (s.link / 1e9) + ' Gb/s' : s.link >= 1e6 ? Math.round(s.link / 1e6) + ' Mb/s' : '';
    linkEl.textContent = mbps.toFixed(mbps < 10 ? 1 : 0) + ' Mb/s' + (link ? ' / ' + link : '');

    // scene reactions: exposure breathes with traffic, fog thickens on bad ping,
    // street lamps shift warm -> cool as the network heats up
    var load = Math.min(1, mbps / 50);
    expoTarget = (1.06 + load * 0.24) * envExpo;
    // clear days see much further; the wide high shots otherwise drown in fog
    fogFarTarget = (lastPing < 0 ? 360 : 430 - Math.min(110, Math.max(0, lastPing - 35) * 0.9)) *
                   (1 + envDayW * 0.9);
    if (!bulbOff) bulbOff = new THREE.Color(0x3a4350);
    bulbMat.color.copy(bulbWarm).lerp(bulbCool, load).lerp(bulbOff, bulbOffW);

    // busy network = wider highway (hysteresis so it doesn't flap)
    bwEma = bwEma * 0.7 + mbps * 0.3;
    // bandwidth spike: send the freight train across the skyline
    if (!train && bwEma > 16 && performance.now() > trainCooldownUntil) {
      spawnTrain(Math.min(10, 3 + Math.floor(bwEma / 8)), bwEma);
      trainCooldownUntil = performance.now() + 60000;
    }
    // heavy download -> airplane on landing approach; heavy upload -> takeoff
    dlEma = dlEma * 0.7 + (s.bpsIn * 8 / 1e6) * 0.3;
    upEma = upEma * 0.7 + (s.bpsOut * 8 / 1e6) * 0.3;
    if (!plane && performance.now() > planeCooldownUntil) {
      if (dlEma > 20) { spawnPlane(true); planeCooldownUntil = performance.now() + 90000; }
      else if (upEma > 12) { spawnPlane(false); planeCooldownUntil = performance.now() + 90000; }
    }
    if (!lanesManual) {
      if (targetLanes < 6 && bwEma > 30) targetLanes = 6;
      else if (targetLanes < 5 && bwEma > 10) targetLanes = 5;
      else if (targetLanes > 5 && bwEma < 22) targetLanes = 5;
      else if (targetLanes > 4 && bwEma < 6) targetLanes = 4;
    }
  }
  function handleServers(d) {
    lastServers = d.count;
    srvCountEl.textContent = d.count;
    setDroneCount(Math.min(5, Math.floor(d.count / 8)));
    // each drone is a delivery drone for a top-talker app: hangs its logo
    for (var di = 0; di < drones.length; di++) {
      var srvIcon = d.top[di] && d.top[di].icon;
      var dr = drones[di];
      if (srvIcon && dr.iconKey !== srvIcon) {
        if (dr.badge) dr.g.remove(dr.badge);
        dr.badge = iconSprite(srvIcon);
        dr.badge.scale.set(1.7, 1.7, 1);
        dr.badge.position.set(0, -1.15, 0);
        dr.g.add(dr.badge);
        dr.iconKey = srvIcon;
      } else if (!srvIcon && !dr.badge) { // unattributed server: globe badge
        dr.badge = protoBadge('other');
        dr.badge.scale.set(1.3, 1.3, 1);
        dr.badge.position.set(0, -1.1, 0);
        dr.g.add(dr.badge);
        dr.iconKey = '_generic';
      }
    }
    var html = '';
    d.top.forEach(function (s) {
      var label = s.host || s.ip;
      if (label.length > 32) label = label.slice(0, 31) + '…';
      html += '<div class="row">' +
        (s.icon ? '<img src="/icon/' + s.icon + '.png" alt="">' : '<span class="ph"></span>') +
        '<span class="host" title="' + s.ip + '">' + esc(label) + '</span>' +
        '<span class="pk">' + s.pkts + '</span></div>';
    });
    srvRows.innerHTML = html;
  }

  if (STATIC) {
    startStaticDemo();
  } else {
    var es = new EventSource('/events');
    es.addEventListener('pkts', function (e) { handlePkts(JSON.parse(e.data)); });
    es.addEventListener('stats', function (e) { handleStats(JSON.parse(e.data)); });
    es.addEventListener('servers', function (e) { handleServers(JSON.parse(e.data)); });
    es.addEventListener('status', function (e) {
      var s = JSON.parse(e.data);
      setBadge(s.mode, s.source);
    });
    es.addEventListener('control', function (e) {
      paused = !!JSON.parse(e.data).pause;
    });
    es.addEventListener('acc', function (e) {
      var v = JSON.parse(e.data);
      accident(v.kind || 'drop', v.n || 1);
    });
    es.addEventListener('sys', function (e) {
      var v = JSON.parse(e.data);
      sysStat.cpu = v.cpu >= 0 ? v.cpu : 0;
      sysStat.gpu = v.gpu;
      sysStat.ramPct = v.ramPct;
      sysStat.ramTxt = v.ramUsed + ' / ' + v.ramTotal + ' GB';
      sysStat.disk = v.disk;
      sysStat.io = (v.dr || 0) + (v.dw || 0);
      sysStat.ioTxt = 'R ' + fmtBytes(v.dr || 0) + '/s · W ' + fmtBytes(v.dw || 0) + '/s';
      redrawUtilPlates();
    });
    es.addEventListener('procs', function (e) {
      handleProcs(JSON.parse(e.data));
    });
    es.addEventListener('env', function (e) {
      var v = JSON.parse(e.data);
      var code = v.code | 0;
      envSnow = (code >= 71 && code <= 77) || code === 85 || code === 86;
      var raining = v.precip > 0 || (code >= 51 && code <= 67) ||
                    (code >= 80 && code <= 82) || code >= 95 || envSnow;
      envRain = raining ? Math.max(0.35, Math.min(1, v.precip / 3 + 0.35)) : 0;
      rainMat.color.setHex(envSnow ? 0xeef4ff : 0xa8c8e0);
      rainFallSpeed = envSnow ? 10 : 45;
      applyEnvironment();
    });
    es.addEventListener('layout', function (e) {
      if (window.__phApplyLayout) window.__phApplyLayout(JSON.parse(e.data));
    });
    es.onerror = function () { // EventSource retries automatically; show it
      badge.classList.remove('demo'); badge.classList.add('error');
      badge.textContent = 'RECONNECTING…';
    };
  }

  // Client-side synthetic traffic for static hosting — mirrors the backend's
  // demo generator (same event shapes) so the rest of the app is unchanged.
  function startStaticDemo() {
    setBadge('demo', 'synthetic traffic');
    var protos = ['https', 'https', 'https', 'https', 'quic', 'quic', 'http', 'dns', 'dns', 'tcp', 'tcp', 'udp', 'icmp', 'arp', 'ssh', 'other'];
    var apps = ['msedge', 'chrome', 'firefox', 'spotify', 'discord', 'steam', 'Code'];
    var hosts = [
      { ip: '1.1.1.1', host: 'one.one.one.one' },
      { ip: '8.8.8.8', host: 'dns.google' },
      { ip: '140.82.121.4', host: 'github.com' },
      { ip: '142.250.74.110', host: 'fra16s48-in-f14.1e100.net' },
      { ip: '104.16.132.229', host: 'cloudflare.com' },
      { ip: '13.107.42.16', host: 'a-0001.a-msedge.net' },
      { ip: '151.101.1.140', host: 'reddit.map.fastly.net' },
      { ip: '185.199.108.153', host: 'pages.github.com' }
    ];
    var c = { pi: 0, po: 0, bi: 0, bo: 0 };
    var srv = {};
    function portOf(proto) {
      if (proto === 'https' || proto === 'quic') return 443;
      if (proto === 'http') return 80;
      if (proto === 'dns') return 53;
      if (proto === 'ssh') return 22;
      return 1024 + (Math.random() * 60000 | 0);
    }
    function cargoOf(p) {
      if (p.proto === 'dns') return 'lookup';
      if (p.proto === 'arp' || p.proto === 'icmp') return null;
      var a = (p.app || '').toLowerCase();
      if (p.bytes >= 1100) return a.indexOf('spotify') >= 0 ? 'audio' : 'media';
      if (p.bytes >= 400) return 'data';
      if (p.bytes >= 120) return 'text';
      return 'control';
    }
    function burst() {
      var n = 1 + (Math.random() * 3 | 0), arr = [];
      for (var i = 0; i < n; i++) {
        var proto = protos[Math.random() * protos.length | 0];
        var outb = Math.random() < 0.5;
        var h = hosts[Math.random() * hosts.length | 0];
        var app = (proto === 'arp' || proto === 'icmp' || Math.random() < 0.2) ? null : apps[Math.random() * apps.length | 0];
        var bytes = Math.random() < 0.1 ? 800 + (Math.random() * 8000 | 0) : 60 + (Math.random() * 600 | 0);
        var p = {
          proto: proto, dir: outb ? 'out' : 'in', bytes: bytes,
          src: outb ? '192.168.1.23' : h.ip, dst: outb ? h.ip : '192.168.1.23',
          sport: 40000 + (Math.random() * 20000 | 0), dport: portOf(proto),
          app: app, icon: null, t: Date.now()
        };
        p.cargo = cargoOf(p);
        arr.push(p);
        if (outb) { c.po++; c.bo += bytes; } else { c.pi++; c.bi += bytes; }
        var e = srv[h.ip] || (srv[h.ip] = { host: h.host, pkts: 0, app: null });
        e.pkts++; if (app) e.app = app;
      }
      handlePkts(arr);
      setTimeout(burst, 150 + Math.random() * 500);
    }
    burst();
    setInterval(function () { // an occasional wreck so the demo shows the feature
      var kinds = ['drop', 'dup', 'loss'];
      accident(kinds[(Math.random() * kinds.length) | 0], 1 + (Math.random() * 4 | 0));
    }, 75000);
    // synthetic machine telemetry + process skyline for the static demo
    var dCpu = 25, dGpu = 18, dRam = 52;
    var dProcs = ['chrome', 'msedge', 'Code', 'discord', 'spotify', 'steam', 'explorer',
      'dwm', 'svchost', 'node', 'Teams', 'OneDrive', 'SearchHost', 'powershell'];
    setInterval(function () {
      dCpu = Math.max(4, Math.min(96, dCpu + (Math.random() * 22 - 11)));
      dGpu = Math.max(2, Math.min(90, dGpu + (Math.random() * 16 - 8)));
      dRam = Math.max(35, Math.min(88, dRam + (Math.random() * 4 - 2)));
      sysStat.cpu = dCpu; sysStat.gpu = dGpu; sysStat.ramPct = dRam;
      sysStat.ramTxt = (dRam * 0.32).toFixed(1) + ' / 32.0 GB';
      sysStat.disk = 71;
      var io = Math.random() < 0.3 ? (Math.random() * 4e7) | 0 : (Math.random() * 4e5) | 0;
      sysStat.io = io;
      sysStat.ioTxt = 'R ' + fmtBytes(io * 0.7 | 0) + '/s · W ' + fmtBytes(io * 0.3 | 0) + '/s';
      redrawUtilPlates();
      handleProcs(dProcs.map(function (n, i) {
        return { n: n, ram: Math.max(80, 2200 * Math.pow(0.72, i) * (0.8 + Math.random() * 0.4)), cpu: Math.random() * (i < 4 ? 60 : 12) };
      }));
    }, 2500);
    setInterval(function () {
      handleStats({
        ppsIn: c.pi, ppsOut: c.po, bpsIn: c.bi, bpsOut: c.bo, pct: 100,
        ping: 14 + (Math.random() * 14 | 0), link: 1e9,
        mode: 'demo', source: 'synthetic traffic'
      });
      c.pi = c.po = c.bi = c.bo = 0;
    }, 1000);
    setInterval(function () {
      var ips = Object.keys(srv);
      var top = ips.map(function (ip) {
        var s = srv[ip];
        return { ip: ip, host: s.host, app: s.app, icon: null, pkts: s.pkts };
      }).sort(function (a, b) { return b.pkts - a.pkts; }).slice(0, 6);
      handleServers({ count: ips.length, top: top });
    }, 2000);
  }

  // ------------------------------------------------------------ controls
  if (!WALLPAPER) {
    var dragging = false, px = 0, py = 0, moved = 0;
    canvas.addEventListener('pointerdown', function (e) { dragging = true; moved = 0; px = e.clientX; py = e.clientY; });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - px, dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      px = e.clientX; py = e.clientY;
      camYaw -= dx * 0.004;
      camPitch = Math.max(0.08, Math.min(1.2, camPitch + dy * 0.003));
      applyCamera();
    });
    window.addEventListener('pointerup', function (e) {
      if (dragging && moved < 6) inspect(e);
      dragging = false;
    });
    canvas.addEventListener('wheel', function (e) {
      camDist = Math.max(35, Math.min(220, camDist + e.deltaY * 0.08));
      applyCamera();
      e.preventDefault();
    }, { passive: false });

    var ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    var inspectEl = document.getElementById('inspect');
    function inspect(e) {
      ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
      ptr.y = -(e.clientY / window.innerHeight) * 2 + 1;
      ray.setFromCamera(ptr, camera);
      var hits = ray.intersectObjects(carsRoot.children, true);
      if (!hits.length) { inspectEl.style.display = 'none'; return; }
      var obj = hits[0].object;
      while (obj.parent && obj.parent !== carsRoot) obj = obj.parent;
      var car = cars.find(function (c) { return c.group === obj; });
      if (!car) { inspectEl.style.display = 'none'; return; }
      var p = car.pkt, d = VEHICLES[p.proto] || VEHICLES.other;
      inspectEl.innerHTML =
        '<h3>' + (p.icon ? '<img src="/icon/' + p.icon + '.png">' : '') + d.veh + ' · ' + d.proto + '</h3>' +
        '<div><span>app</span>' + esc(p.app || '—') + '</div>' +
        '<div><span>from</span>' + esc((p.src || '?') + (p.sport ? ':' + p.sport : '')) + '</div>' +
        '<div><span>to</span>' + esc((p.dst || '?') + (p.dport ? ':' + p.dport : '')) + '</div>' +
        '<div><span>size</span>' + fmtBytes(p.bytes) + '</div>' +
        '<div><span>cargo</span>' + esc(p.cargo || '—') + '</div>' +
        '<div><span>dest</span>' + esc(p.dest || '—') + '</div>' +
        '<div><span>dir</span>' + (p.dir === 'in' ? 'incoming ↓' : 'outgoing ↑') + '</div>';
      inspectEl.style.display = 'block';
      clearTimeout(inspect._t);
      inspect._t = setTimeout(function () { inspectEl.style.display = 'none'; }, 8000);
    }
  }

  // ------------------------------------------------- movable HUD panels
  // drag to move, [-] minimize, [x] close (restore via the bottom dock).
  // Layout persists to localStorage AND the backend (/layout), which rebroadcasts
  // it over SSE — so arranging panels in the browser updates the wallpaper live.
  (function panels() {
    var keys = ['dash', 'legend', 'log', 'servers'];
    var layout = {}, saveT = null;
    var dockEl = document.getElementById('dock');

    function apply() {
      keys.forEach(function (k) {
        var el = document.getElementById(k);
        var st = layout[k] || {};
        if (st.x != null) {
          el.style.left = (st.x * 100) + '%';
          el.style.top = (st.y * 100) + '%';
          el.style.right = 'auto'; el.style.bottom = 'auto';
        } else {
          el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = '';
        }
        el.classList.toggle('min', !!st.min);
        el.style.display = st.hidden ? 'none' : '';
      });
      var hidden = keys.filter(function (k) { return layout[k] && layout[k].hidden; });
      dockEl.style.display = hidden.length && !WALLPAPER ? 'flex' : 'none';
      dockEl.innerHTML = hidden.map(function (k) { return '<span data-k="' + k + '">+ ' + k + '</span>'; }).join('');
    }
    function save() {
      try { localStorage.setItem('ph-layout', JSON.stringify(layout)); } catch (e) { }
      if (STATIC) return;
      clearTimeout(saveT);
      saveT = setTimeout(function () {
        try { fetch('/layout', { method: 'POST', body: JSON.stringify(layout) }); } catch (e) { }
      }, 300);
    }
    dockEl.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-k');
      if (!k) return;
      layout[k].hidden = false; save(); apply();
    });

    keys.forEach(function (k) {
      var el = document.getElementById(k);
      var head = el.querySelector('h1, h2');
      if (head) head.classList.add('ptitle');
      var btns = document.createElement('span');
      btns.className = 'pbtns';
      btns.innerHTML = '<b class="pm" title="minimize">–</b><b class="px" title="close">×</b>';
      el.appendChild(btns);
      btns.querySelector('.pm').addEventListener('click', function (e) {
        e.stopPropagation();
        layout[k] = layout[k] || {};
        layout[k].min = !layout[k].min; save(); apply();
      });
      btns.querySelector('.px').addEventListener('click', function (e) {
        e.stopPropagation();
        layout[k] = layout[k] || {};
        layout[k].hidden = true; save(); apply();
      });
      if (WALLPAPER) return; // wallpaper window gets no input; layout arrives via SSE

      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.pbtns')) return;
        var r = el.getBoundingClientRect();
        var ox = e.clientX - r.left, oy = e.clientY - r.top;
        el.classList.add('dragging');
        el.setPointerCapture(e.pointerId);
        function mv(ev) {
          layout[k] = layout[k] || {};
          layout[k].x = Math.max(0, Math.min(0.97, (ev.clientX - ox) / window.innerWidth));
          layout[k].y = Math.max(0, Math.min(0.97, (ev.clientY - oy) / window.innerHeight));
          el.style.left = (layout[k].x * 100) + '%';
          el.style.top = (layout[k].y * 100) + '%';
          el.style.right = 'auto'; el.style.bottom = 'auto';
        }
        function up(ev) {
          el.classList.remove('dragging');
          el.removeEventListener('pointermove', mv);
          el.removeEventListener('pointerup', up);
          try { el.releasePointerCapture(ev.pointerId); } catch (e2) { }
          save();
        }
        el.addEventListener('pointermove', mv);
        el.addEventListener('pointerup', up);
        e.stopPropagation();
      });
    });

    try { layout = JSON.parse(localStorage.getItem('ph-layout')) || {}; } catch (e) { layout = {}; }
    apply();
    if (!STATIC) {
      fetch('/layout').then(function (r) { return r.json(); }).then(function (l) {
        if (l && typeof l === 'object' && Object.keys(l).length) { layout = l; apply(); }
      }).catch(function () { });
      window.__phApplyLayout = function (l) { layout = l || {}; apply(); };
    }
  })();

  // debug handle (e.g. __ph.lanes(6) from devtools; __ph.auto() resumes bandwidth control)
  var lanesManual = false;
  window.__ph = {
    lanes: function (n) { lanesManual = true; targetLanes = Math.max(LANE_MIN, Math.min(LANE_MAX, n)); },
    auto: function () { lanesManual = false; },
    train: function (n) { spawnTrain(n || 6); },
    plane: function (land) { spawnPlane(land !== false); },
    rain: function (lvl) { envRain = lvl == null ? 0.7 : lvl; applyEnvironment(); },
    crash: function (k, n) { lastAcc = 0; accident(k || 'drop', n || 3); },
    crashCount: function () { return crashes.length; },
    cam: function (yaw, pitch, dist, tz, tx) {
      camYaw = yaw; camPitch = pitch; camDist = dist;
      if (tz != null) camTarget.z = tz;
      if (tx != null) camTarget.x = tx;
      applyCamera();
    },
    env: function () {
      return JSON.stringify({
        h: (__ph._h != null) ? __ph._h : (new Date().getHours() + new Date().getMinutes() / 60),
        dayW: envDayW, rain: envRain, expo: envExpo,
        fog: scene.fog.color.getHexString(), bg: scene.background.getHexString(),
        paused: paused, frame: renderer.info.render.frame
      });
    },
    hour: function (h) { // preview a time of day, e.g. __ph.hour(17.5) for golden hour
      __ph._h = h; applyEnvironment();
    }
  };

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ----------------------------------------- environment: time + weather
  // sky/light palettes follow the real local clock (golden hour included);
  // rain/snow arrive from the backend's weather feed (open-meteo)
  var PHASES = {
    night:  { top: 0x05060f, mid: 0x1a1238, hor: 0x3a2450, fog: 0x131a30, hemiSky: 0x3a4a78, hemiGnd: 0x1a1238, hemiI: 1.25, dlC: 0x9db8e8, dlI: 0.7, stars: 1, sunY: -180, sunC: 0xffffff, expo: 1 },
    golden: { top: 0x2a2438, mid: 0x7a4252, hor: 0xe08040, fog: 0x4a3340, hemiSky: 0xc08a5a, hemiGnd: 0x4a2e3a, hemiI: 1.2, dlC: 0xffb060, dlI: 1.15, stars: 0.15, sunY: 46, sunC: 0xffd0a0, expo: 1.05 },
    day:    { top: 0x3d7ecf, mid: 0x74a8dc, hor: 0xaecdea, fog: 0x8fabc6, hemiSky: 0xaccae8, hemiGnd: 0x7a8694, hemiI: 1.45, dlC: 0xfff2dd, dlI: 1.55, stars: 0, sunY: 340, sunC: 0xffffff, expo: 0.98 }
  };
  var RAIN_N = ECO ? 400 : 1500;
  var rainGeo = new THREE.BufferGeometry();
  (function () {
    var arr = [];
    for (var i = 0; i < RAIN_N; i++)
      arr.push(-90 + Math.random() * 180, Math.random() * 70, -230 + Math.random() * 300);
    rainGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  })();
  var rainMat = new THREE.PointsMaterial({ color: 0xa8c8e0, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.55 });
  var rainPts = new THREE.Points(rainGeo, rainMat);
  rainPts.visible = false; rainPts.frustumCulled = false;
  scene.add(rainPts);
  function stepRain(dt) {
    if (!rainPts.visible) return;
    var p = rainGeo.attributes.position;
    var n = Math.floor(RAIN_N * Math.max(0.1, envRain));
    for (var i = 0; i < n; i++) {
      var y = p.getY(i) - (rainFallSpeed + (i % 7) * 3) * dt;
      if (y < 0) y = 60 + Math.random() * 10;
      p.setY(i, y);
    }
    p.needsUpdate = true;
  }

  function applyEnvironment() {
    var d = new Date();
    var h = (window.__ph && window.__ph._h != null) ? window.__ph._h : d.getHours() + d.getMinutes() / 60;
    var sunAlt = Math.sin((h - 6) / 12 * Math.PI); // crude solar elevation
    var day = Math.max(0, Math.min(1, (sunAlt - 0.12) / 0.28));
    var golden = Math.max(0, 1 - Math.abs(sunAlt - 0.07) / 0.16);
    var night = Math.max(0, Math.min(1, (0.02 - sunAlt) / 0.2));
    var sum = day + golden + night || 1;
    var w = { night: night / sum, golden: golden / sum, day: day / sum };
    function blendC(f) {
      var c = new THREE.Color(0, 0, 0);
      Object.keys(w).forEach(function (k) {
        var p = new THREE.Color(PHASES[k][f]);
        c.r += p.r * w[k]; c.g += p.g * w[k]; c.b += p.b * w[k];
      });
      return c;
    }
    function blendN(f) {
      var v = 0;
      Object.keys(w).forEach(function (k) { v += PHASES[k][f] * w[k]; });
      return v;
    }
    var fogC = blendC('fog');
    if (envRain > 0) fogC.multiplyScalar(1 - envRain * 0.35); // rain darkens the sky
    scene.fog.color.copy(fogC);
    scene.background.copy(fogC);
    setDomeColors(blendC('top').getHex(), blendC('mid').getHex(), blendC('hor').getHex());
    hemi.color.copy(blendC('hemiSky')); hemi.groundColor.copy(blendC('hemiGnd'));
    hemi.intensity = blendN('hemiI') * (1 - envRain * 0.25);
    dl.color.copy(blendC('dlC'));
    dl.intensity = blendN('dlI') * (1 - envRain * 0.4);
    starsScale = blendN('stars') * (1 - envRain * 0.8);
    envExpo = blendN('expo');
    // the sun tracks the real clock: rises east (+x), noon overhead, sets west
    var sunX = -40 + Math.cos((h - 6) / 12 * Math.PI) * 320;
    var sunYday = 50 + Math.max(0, sunAlt) * 380;
    sunSprite.position.y = blendN('sunY');
    sunSprite.position.x = -40 + (sunX + 40) * w.day;
    sunHalo.position.copy(sunSprite.position);
    sunSprite.material.color.copy(blendC('sunC'));
    sunSprite.material.opacity = (1 - w.day * 0.9) * (1 - envRain * 0.6); // stripes are a night thing
    sunHalo.material.opacity = 0.7 * (1 - envRain * 0.7);
    daySun.position.set(sunX, sunYday, -800);
    daySun.material.opacity = w.day * (1 - envRain * 0.75);
    var glowOn = w.night > 0.3 || envRain > 0.4; // street glow at night or in rain
    nightGlow.forEach(function (m) { m.visible = glowOn; });
    rainPts.visible = envRain > 0;
    rainMat.opacity = 0.35 + envRain * 0.4;
    starsMat.visible = starsMat2.visible = starsScale > 0.02; // hard-off by day
    if (_beamMat) _beamMat.opacity = 1 - envDayW * 0.85;      // headlight beams are a night thing
    if (pollutionMat) {
      pollutionMat.color.copy(blendC('hor')).multiplyScalar(1.3);
      pollutionMat.opacity = 0.5 - envDayW * 0.3 + envRain * 0.1;
    }

    // daylight ground truth: lit windows go out, facades turn concrete,
    // the horizon silhouettes haze into the sky, asphalt + ground lighten
    envDayW = w.day;
    bulbOffW = envDayW;
    var dayMode = envDayW > 0.5;
    buildingsList.forEach(function (b2) {
      var map = dayMode ? b2.day : b2.night;
      if (b2.mat.map !== map) { b2.mat.map = map; b2.mat.needsUpdate = true; }
    });
    appCity.forEach(function (t2) {
      var map2 = dayMode ? t2.bodyDay : t2.body;
      if (t2.mesh.material.map !== map2) { t2.mesh.material.map = map2; t2.mesh.material.needsUpdate = true; }
    });
    skylineMats.forEach(function (m2) { // night depth-seller; nearly gone by day
      m2.color.setScalar(1 + envDayW * 1.6);
      m2.opacity = 1 - envDayW * 0.88;
    });
    ground.material.color.set(0x05070d).lerp(new THREE.Color(0x5d6873), envDayW);
    roofMat.color.set(0x222936).lerp(new THREE.Color(0x7e8792), envDayW);
    roadMeshes.forEach(function (m3) { m3.material.color.setScalar(1 + envDayW * 0.55); });
  }
  setInterval(applyEnvironment, 60000);
  applyEnvironment();

  // ------------------------------------------------------------ loop
  var last = performance.now(), acc = 0, frameMs = 1000 / FPS_CAP;
  var paused = false;                       // set by backend "control" events
  var expoTarget = 1.15, fogFarTarget = 430; // stat-driven scene reactions

  // cinematic shot director: hold a framing, glide to the next (wallpaper only)
  var SHOTS = [
    { yaw: 0.62, pitch: 0.30, dist: 95, tz: -50 },
    { yaw: 0.95, pitch: 0.17, dist: 62, tz: -25 },
    { yaw: 0.30, pitch: 0.52, dist: 135, tz: -85 },
    { yaw: -0.55, pitch: 0.24, dist: 75, tz: -40 }
  ];
  var shotIdx = 0, shotStart = 0, SHOT_HOLD = 32000, SHOT_GLIDE = 4500;
  function easeC(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function loop(now) {
    requestAnimationFrame(loop);
    acc += now - last; last = now;
    if (acc < (paused ? 1000 : frameMs)) return;
    var dt = Math.min(0.15, acc / 1000); // consume all accumulated time
    acc = 0;
    if (paused) return; // fullscreen app in front: skip all work, free the GPU

    if (WALLPAPER) {
      if (!shotStart) shotStart = now;
      var se = now - shotStart;
      if (se > SHOT_HOLD + SHOT_GLIDE) { shotIdx = (shotIdx + 1) % SHOTS.length; shotStart = now; se = 0; }
      var a = SHOTS[shotIdx], b = SHOTS[(shotIdx + 1) % SHOTS.length];
      var k = se <= SHOT_HOLD ? 0 : easeC((se - SHOT_HOLD) / SHOT_GLIDE);
      camYaw = a.yaw + (b.yaw - a.yaw) * k + Math.sin(now * 0.000045) * 0.05;
      camPitch = a.pitch + (b.pitch - a.pitch) * k + Math.sin(now * 0.00003) * 0.02;
      camDist = a.dist + (b.dist - a.dist) * k;
      camTarget.z = a.tz + (b.tz - a.tz) * k;
      applyCamera();
    }

    // ambient dynamics: twinkle, exposure breathing, ping-weather fog, rain
    if (starsMat) {
      starsMat.opacity = (0.62 + 0.25 * Math.sin(now * 0.0005)) * starsScale;
      starsMat2.opacity = (0.4 + 0.2 * Math.sin(now * 0.00037 + 2)) * starsScale;
    }
    renderer.toneMappingExposure += (expoTarget - renderer.toneMappingExposure) * Math.min(1, dt);
    scene.fog.far += (fogFarTarget - scene.fog.far) * Math.min(1, dt * 0.4);
    stepRain(dt);

    step(dt, now);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
})();
