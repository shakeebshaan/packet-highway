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
  var PIXEL_RATIO = (ECO || WALLPAPER) ? 1 : Math.min(window.devicePixelRatio || 1, 2);
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
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !ECO && !WALLPAPER, powerPreference: ECO ? 'low-power' : 'default' });
  renderer.setPixelRatio(PIXEL_RATIO);
  renderer.setSize(window.innerWidth, window.innerHeight);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060c);
  scene.fog = new THREE.Fog(0x04060c, 130, 430);

  var camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 800);
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

  scene.add(new THREE.HemisphereLight(0x33415e, 0x05070d, 0.9));
  var dl = new THREE.DirectionalLight(0x8fb0e0, 0.55);
  dl.position.set(-40, 80, 30);
  scene.add(dl);

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
    g.fillStyle = '#0b0e15'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.02)';
    for (var i = 0; i < 300; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    var lw = 256 / n; // n lanes => n-1 dashed separators + solid edges
    g.strokeStyle = '#c9cdd6'; g.lineWidth = 3; g.setLineDash([26, 30]);
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

  // street lights along the median
  var poleMat = new THREE.MeshLambertMaterial({ color: 0x1a2030 });
  var bulbMat = new THREE.MeshBasicMaterial({ color: 0xf8edc8 });
  for (var z = Z0 + 20; z < Z1; z += 46) {
    var pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9, 0.35), poleMat);
    pole.position.set(0, 4.5, z); scene.add(pole);
    var bulb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.6), bulbMat);
    bulb.position.set(0, 9, z); scene.add(bulb);
  }

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
  for (var b = 0; b < BUILDING_COUNT; b++) {
    var w = 14 + Math.random() * 26, h = 20 + Math.random() * 55, d = 14 + Math.random() * 26;
    var side = Math.random() < 0.5 ? -1 : 1;
    var bx = side * (52 + Math.random() * 110);
    var bz = Z0 + Math.random() * (ROAD_LEN + 40) - 40;
    if (bz > -80 && Math.abs(bx) < 95) bx = side * (95 + Math.random() * 70); // keep clear of the camera
    // tile the window texture by building size so windows stay sharp
    var tex = bTex[b % bTex.length].clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, Math.round(w / 14)), Math.max(1, Math.round(h / 26)));
    tex.needsUpdate = true;
    var mat = new THREE.MeshBasicMaterial({ map: tex });
    var bld = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    bld.position.set(bx, h / 2 - 0.1, bz);
    scene.add(bld);
  }

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
    var c = document.createElement('canvas'); c.width = 512; c.height = 128;
    signCtx = c.getContext('2d');
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

  // ------------------------------------------------------------ vehicles
  var matCache = {};
  function lambert(color) {
    if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({ color: color });
    return matCache[color];
  }
  var MAT = {
    glass: new THREE.MeshLambertMaterial({ color: 0x0d1422, emissive: 0x202c44, emissiveIntensity: 0.6 }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff6d8 }),
    tail: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    tire: new THREE.MeshLambertMaterial({ color: 0x090a0e }),
    dark: new THREE.MeshLambertMaterial({ color: 0x10141e }),
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
      box(g, 2.2, 0.4, 0.1, MAT.tail, 0, 1.2, 4.51);
      wheels(g, 2.1, 9, 0.5);
      return g;
    },
    quic: function () { // sports car
      var g = new THREE.Group(), c = lambert(VEHICLES.quic.color);
      box(g, 2.1, 0.55, 4.2, c, 0, 0.65, 0);
      box(g, 1.9, 0.45, 2.0, MAT.glass, 0, 1.12, 0.2);
      box(g, 1.7, 0.18, 0.4, c, 0, 1.0, 2.0); // spoiler
      box(g, 1.7, 0.22, 0.08, MAT.head, 0, 0.62, -2.12);
      box(g, 1.7, 0.2, 0.08, MAT.tail, 0, 0.66, 2.12);
      wheels(g, 1.8, 4.2, 0.38);
      return g;
    },
    http: function () { // box truck
      var g = new THREE.Group(), c = lambert(VEHICLES.http.color);
      box(g, 2.4, 2.6, 5.4, c, 0, 1.85, 1.2);                 // cargo box
      box(g, 2.2, 1.5, 2.2, MAT.dark, 0, 1.0, -2.7);          // cab
      box(g, 2.1, 0.6, 0.1, MAT.glass, 0, 1.45, -3.8);
      box(g, 1.9, 0.3, 0.1, MAT.head, 0, 0.65, -3.82);
      box(g, 2.2, 0.4, 0.1, MAT.tail, 0, 1.0, 3.95);
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
      box(g, 1.9, 0.35, 0.1, MAT.tail, 0, 0.9, 2.81);
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
      box(g, 1.7, 0.26, 0.1, MAT.tail, 0, 0.85, 1.91);
      wheels(g, 1.7, 3.8, 0.38);
      return g;
    }
  };
  function sedanBody(color) {
    var g = new THREE.Group(), c = lambert(color);
    box(g, 2.1, 0.75, 4.6, c, 0, 0.85, 0);
    box(g, 1.95, 0.65, 2.3, MAT.glass, 0, 1.55, 0.1);
    box(g, 1.8, 0.26, 0.1, MAT.head, 0, 0.75, -2.31);
    box(g, 1.8, 0.26, 0.1, MAT.tail, 0, 0.85, 2.31);
    wheels(g, 1.8, 4.6, 0.4);
    return g;
  }

  // one template per vehicle type; clones share geometries and materials,
  // so spawning never allocates GPU resources (critical for a 24/7 wallpaper)
  var TEMPLATES = {};
  function getTemplate(proto) {
    var key = proto in FACTORY ? proto : 'other';
    if (!TEMPLATES[key]) {
      var g = FACTORY[key]();
      var bb = new THREE.Box3().setFromObject(g);
      TEMPLATES[key] = { group: g, h: bb.max.y };
    }
    return TEMPLATES[key];
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
    g.position.set(lane.x, 0, startZ);
    if (dirSign === 1) g.rotation.y = Math.PI; // face +z
    carsRoot.add(g);

    var car = {
      group: g, lane: lane, dir: dirSign,
      speed: def.speed * lane.f * (0.92 + Math.random() * 0.16),
      len: def.len, pkt: pkt, flashT: Math.random() * Math.PI,
      icon: null, h: tpl.h
    };
    if (pkt.icon) {
      var s = iconSprite(pkt.icon);
      s.position.set(0, car.h + 1.7, 0);
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
      }
      c.group.position.z += move * c.dir;

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
  })();

  var LOG_MAX = 13;
  function logPacket(p) {
    var d = VEHICLES[p.proto] || VEHICLES.other;
    var row = document.createElement('div'); row.className = 'row';
    var app = p.app
      ? '<span class="app">' + (p.icon ? '<img src="/icon/' + p.icon + '.png" alt="">' : '') + esc(p.app) + '</span>'
      : '<span class="app"></span>';
    row.innerHTML = '<span class="dot" style="background:' + d.css + '"></span>' +
      '<span class="proto">' + PROTO_LABEL[p.proto] + '</span>' + app +
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
    }
  }
  var bwEma = 0;
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

    // busy network = wider highway (hysteresis so it doesn't flap)
    bwEma = bwEma * 0.7 + mbps * 0.3;
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
        '<div><span>dir</span>' + (p.dir === 'in' ? 'incoming ↓' : 'outgoing ↑') + '</div>';
      inspectEl.style.display = 'block';
      clearTimeout(inspect._t);
      inspect._t = setTimeout(function () { inspectEl.style.display = 'none'; }, 8000);
    }
  }

  // debug handle (e.g. __ph.lanes(6) from devtools; __ph.auto() resumes bandwidth control)
  var lanesManual = false;
  window.__ph = {
    lanes: function (n) { lanesManual = true; targetLanes = Math.max(LANE_MIN, Math.min(LANE_MAX, n)); },
    auto: function () { lanesManual = false; }
  };

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ------------------------------------------------------------ loop
  var last = performance.now(), acc = 0, frameMs = 1000 / FPS_CAP;
  function loop(now) {
    requestAnimationFrame(loop);
    acc += now - last; last = now;
    if (acc < frameMs) return;
    var dt = Math.min(0.15, acc / 1000); // consume all accumulated time
    acc = 0;

    if (WALLPAPER) { // slow cinematic drift
      camYaw = 0.62 + Math.sin(now * 0.000045) * 0.10;
      camPitch = 0.30 + Math.sin(now * 0.00003) * 0.03;
      applyCamera();
    }
    step(dt, now);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
})();
