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
  var BUILDING_COUNT = ECO ? 16 : 36;

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
  var domeGeo, sunSprite, sunHalo;
  var nightGlow = []; // glow elements hidden in daylight
  var starsScale = 1, envExpo = 1, envRain = 0, envSnow = false, rainFallSpeed = 45;
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
    g.fillStyle = 'rgba(255,255,255,0.02)';
    for (var i = 0; i < 300; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    var lw = 256 / n; // n lanes => n-1 dashed separators + solid edges
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

  function buildRoads(n) {
    roadMeshes.forEach(function (m) {
      scene.remove(m);
      m.geometry.dispose(); m.material.map.dispose(); m.material.dispose();
    });
    roadMeshes = [];
    var width = n * LANE_W + 1.2, cx = 4.8 + n * LANE_W / 2;
    [[-cx, false], [cx, true]].forEach(function (s) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(width, ROAD_LEN),
        new THREE.MeshLambertMaterial({ map: roadTexture(n) }));
      m.rotation.x = -Math.PI / 2;
      if (s[1]) m.rotation.z = Math.PI; // yellow edge faces the median on both sides
      m.position.set(s[0], 0.01, (Z0 + Z1) / 2);
      scene.add(m);
      roadMeshes.push(m);
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
      map: radialTex('rgba(255,236,190,0.4)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    var pools = new THREE.InstancedMesh(poolGeo, poolMat, lampZ.length);
    var streakGeo = new THREE.PlaneGeometry(2.0, 24); streakGeo.rotateX(-Math.PI / 2);
    var streakMat = new THREE.MeshBasicMaterial({
      map: radialTex('rgba(255,220,170,0.22)'), transparent: true,
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

  // buildings with lit windows
  function buildingTexture() {
    var c = document.createElement('canvas'); c.width = 64; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#070a12'; g.fillRect(0, 0, 64, 128);
    var palette = ['#e8d8a8', '#c8d8f0', '#f0c890', '#a8c8e8'];
    for (var y = 6; y < 122; y += 9)
      for (var x = 5; x < 58; x += 9)
        if (Math.random() < 0.24) {
          g.fillStyle = palette[(Math.random() * palette.length) | 0];
          g.globalAlpha = 0.5 + Math.random() * 0.5;
          g.fillRect(x, y, 5, 4);
        }
    g.globalAlpha = 1;
    return new THREE.CanvasTexture(c);
  }
  var bTex = [buildingTexture(), buildingTexture(), buildingTexture(), buildingTexture()];
  var bbCandidates = [];
  for (var b = 0; b < BUILDING_COUNT; b++) {
    var w = 14 + Math.random() * 26, h = 20 + Math.random() * 55, d = 14 + Math.random() * 26;
    var side = Math.random() < 0.5 ? -1 : 1;
    var bx = side * (52 + Math.random() * 110);
    var bz = Z0 + Math.random() * (ROAD_LEN + 40) - 40;
    if (bz > -80 && Math.abs(bx) < 95) bx = side * (95 + Math.random() * 70); // keep clear of the camera
    if (bx > -100 && bx < -50 && bz > -175 && bz < -10) bx -= 60; // reserve the app-city district
    // tile the window texture by building size so windows stay sharp
    var tex = bTex[b % bTex.length].clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, Math.round(w / 14)), Math.max(1, Math.round(h / 26)));
    tex.needsUpdate = true;
    var mat = new THREE.MeshBasicMaterial({ map: tex });
    var bld = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    bld.position.set(bx, h / 2 - 0.1, bz);
    scene.add(bld);
    if (h > 40 && Math.abs(bx) < 150 && bz > -260 && bz < 20)
      bbCandidates.push({ x: bx, h: h, w: w, d: d, z: bz });
  }

  // living billboards: jumbotrons on the tallest road-facing buildings showing
  // the top-talker apps (icon + relative traffic bar), redrawn every 5 s
  var iconBytes = {}, bbImgCache = {};
  var billboards = [];
  bbCandidates.sort(function (a, b2) { return b2.h - a.h; }).slice(0, ECO ? 0 : 3).forEach(function (cd) {
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
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w3, h3),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false }));
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
    if (!TEMPLATES[key]) {
      var g = FACTORY[key]();
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
      TEMPLATES[key] = { group: g, h: bb.max.y };
    }
    return TEMPLATES[key];
  }

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
  function spawnTrain(nCars) {
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
  function spawnPulse(dirIn) {
    var key = dirIn ? 'in' : 'out';
    var nowMs = performance.now();
    if (wirePulses.length >= 4 || nowMs - _lastPulse[key] < 2000) return;
    _lastPulse[key] = nowMs;
    if (!pulseMat) pulseMat = new THREE.SpriteMaterial({
      map: radialTex('rgba(140,235,255,0.55)'), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var s = new THREE.Sprite(pulseMat);
    s.scale.set(1.8, 1.0, 1);
    var x = (dirIn ? WIRE_XS[0] : WIRE_XS[1]) + (Math.random() < 0.5 ? -0.95 : 0.95);
    s.position.set(x, WIRE_Y - 0.55, dirIn ? Z0 : Z1);
    scene.add(s);
    wirePulses.push({ s: s, dir: dirIn ? 1 : -1 });
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
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(11, 1, 11),
      new THREE.MeshBasicMaterial({ map: body }));
    var plate = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 9.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    plate.rotation.y = Math.PI / 2; // face the highway
    var grp = new THREE.Group();
    grp.add(mesh); grp.add(plate);
    grp.position.set(APPCITY_X, 0, -28 - appCity.length * 17);
    scene.add(grp);
    var t = { key: key, mesh: mesh, body: body, plate: plate, ctx: ctx, tex: tex, cur: 6, target: 10 };
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

  // surveillance drones hover over the city — one per ~8 connected servers
  var drones = [];
  function makeDrone() {
    var g = new THREE.Group();
    box(g, 0.9, 0.25, 0.9, MAT.dark, 0, 0, 0);
    [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].forEach(function (o) {
      box(g, 0.5, 0.06, 0.5, MAT.tire, o[0], 0.16, o[1]);
    });
    var led = box(g, 0.16, 0.16, 0.16, MAT.red, 0, -0.18, 0);
    g.position.set(-25 + Math.random() * 50, 22 + Math.random() * 12, -130 + Math.random() * 150);
    scene.add(g);
    return { g: g, t: Math.random() * 100, cx: g.position.x, cy: g.position.y, cz: g.position.z, led: led };
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
      if (c.icon) c.icon.position.y = c.h + 1.9 + Math.sin(now * 0.0024 + c.flashT) * 0.25;

      if ((c.dir === 1 && c.group.position.z > Z1 + 12) || (c.dir === -1 && c.group.position.z < Z0 - 12))
        removeCar(c);
    }
    if (train) {
      train.grp.position.z -= train.speed * dt;
      if (train.grp.position.z < Z0 - train.len - 40) {
        scene.remove(train.grp);
        train = null;
      }
    }

    stepPlane(dt, now);
    for (var dr = 0; dr < drones.length; dr++) {
      var dd = drones[dr];
      dd.t += dt;
      dd.g.position.set(
        dd.cx + Math.sin(dd.t * 0.4) * 9,
        dd.cy + Math.sin(dd.t * 1.3) * 1.2,
        dd.cz + Math.cos(dd.t * 0.31) * 11);
      dd.led.visible = Math.sin(dd.t * 7) > 0;
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
        t.plate.position.y = t.cur + 6;
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
    if (n < 1024) return n + ' B';
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
      '🏙 tower height = app traffic';
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
      if (arr[i].wire) spawnPulse(arr[i].dir === 'in');
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
    fogFarTarget = lastPing < 0 ? 360 : 430 - Math.min(110, Math.max(0, lastPing - 35) * 0.9);
    bulbMat.color.copy(bulbWarm).lerp(bulbCool, load);

    // busy network = wider highway (hysteresis so it doesn't flap)
    bwEma = bwEma * 0.7 + mbps * 0.3;
    // bandwidth spike: send the freight train across the skyline
    if (!train && bwEma > 16 && performance.now() > trainCooldownUntil) {
      spawnTrain(Math.min(10, 3 + Math.floor(bwEma / 8)));
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
    golden: { top: 0x2a2438, mid: 0x7a4252, hor: 0xe08040, fog: 0x4a3340, hemiSky: 0xc08a5a, hemiGnd: 0x4a2e3a, hemiI: 1.2, dlC: 0xffb060, dlI: 1.15, stars: 0.15, sunY: 46, sunC: 0xffd0a0, expo: 1.12 },
    day:    { top: 0x5a9ade, mid: 0x8abcec, hor: 0xc2dcf4, fog: 0x9cbcd8, hemiSky: 0xbcd8f0, hemiGnd: 0x8090a0, hemiI: 1.6, dlC: 0xfff2dd, dlI: 1.7, stars: 0, sunY: 340, sunC: 0xffffff, expo: 1.25 }
  };
  var RAIN_N = ECO ? 400 : 1500;
  var rainGeo = new THREE.BufferGeometry();
  (function () {
    var arr = [];
    for (var i = 0; i < RAIN_N; i++)
      arr.push(-90 + Math.random() * 180, Math.random() * 70, -230 + Math.random() * 300);
    rainGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  })();
  var rainMat = new THREE.PointsMaterial({ color: 0xa8c8e0, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0.45 });
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
    sunSprite.position.y = blendN('sunY');
    sunHalo.position.y = sunSprite.position.y;
    sunSprite.material.color.copy(blendC('sunC'));
    sunSprite.material.opacity = 1 - envRain * 0.6;
    sunHalo.material.opacity = 0.7 * (1 - envRain * 0.7);
    var glowOn = w.night > 0.3 || envRain > 0.4; // street glow at night or in rain
    nightGlow.forEach(function (m) { m.visible = glowOn; });
    rainPts.visible = envRain > 0;
    rainMat.opacity = 0.25 + envRain * 0.35;
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
