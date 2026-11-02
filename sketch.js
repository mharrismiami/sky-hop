// ---------- Config ----------
const W = 400, H = 640;      // game world (portrait)
const G = 0.38;              // gravity
const JUMP = -11.5;          // normal bounce
const SPRING = -18;          // spring bounce
const MAX_VX = 7;            // top sideways speed
const PW = 70, PH = 16;      // platform size
const DEADZONE = 0.08;       // ignore tiny leans
const FULL_LEAN = 0.45;      // lean amount (in shoulder widths) for full speed

// ---------- State ----------
let video, bodyPose, kp = null, camReady = false;
let bodySeg, cutout = null, crop = null;   // you, cut out of the camera feed
let mode = "loading";        // loading | title | calibrate | play | over
let modeT0 = 0;
let neutral = null, calBuf = [];
let lean = 0;
let player, plats, camY, startY, score, best = 0, topY;
let particles = [];
let scaleK = 1;

try { best = +localStorage.getItem("skyhop-best") || 0; } catch (e) {}

// ---------- p5 ----------
function preload() {
  bodyPose = ml5.bodyPose("MoveNet");
  bodySeg = ml5.bodySegmentation("SelfieSegmentation", { maskType: "body" });
}

function setup() {
  fitScale();
  const c = createCanvas(W * scaleK, H * scaleK);
  c.parent("stage");
  textFont("Fredoka");

  video = createCapture(VIDEO, () => {
    camReady = true;
    bodyPose.detectStart(video, gotPoses);
    bodySeg.detectStart(video, gotSegmentation);
    setMode("title");
  });
  video.size(640, 480);
  video.hide();
}

function windowResized() { fitScale(); resizeCanvas(W * scaleK, H * scaleK); }
function fitScale() { scaleK = Math.min((windowWidth - 16) / W, (windowHeight - 16) / H); }
function setMode(m) { mode = m; modeT0 = millis(); }

// ---------- Body tracking ----------
function gotPoses(results) {
  if (!results || !results.length) { if (kp) kp.forEach(p => p.c *= 0.8); return; }
  const pts = results[0].keypoints;
  if (!kp) kp = pts.map(p => ({ x: p.x, y: p.y, c: p.confidence }));
  else pts.forEach((p, i) => {
    const s = kp[i];
    s.x += (p.x - s.x) * 0.5; s.y += (p.y - s.y) * 0.5; s.c += (p.confidence - s.c) * 0.5;
  });
}

const ok = (i, t = 0.3) => kp && kp[i] && kp[i].c > t;

// Cut you out of the frame: keep only the pixels the segmentation says are your body
function gotSegmentation(result) {
  if (!result || !result.mask) return;
  const img = video.get();
  img.mask(result.mask);
  cutout = img;
  updateCrop();
}

// Box around your head and shoulders, smoothed so the character doesn't jitter
function updateCrop() {
  const s = shoulders();
  if (!s) return;
  const side = s.sw * 2.6;
  const top = ok(0) ? kp[0].y - s.sw * 1.1 : (kp[5].y + kp[6].y) / 2 - s.sw * 1.6;
  const target = { x: s.mx - side / 2, y: top, w: side, h: side };
  if (!crop) crop = target;
  else for (const k in target) crop[k] += (target[k] - crop[k]) * 0.3;
}

// Shoulder midpoint + width (5 = left shoulder, 6 = right shoulder)
function shoulders() {
  if (!ok(5) || !ok(6)) return null;
  const sw = Math.abs(kp[5].x - kp[6].x);
  if (sw < 20) return null;
  return { mx: (kp[5].x + kp[6].x) / 2, sw };
}

// Lean = how far your shoulders moved sideways from where you calibrated, in shoulder widths
function readLean() {
  const s = shoulders();
  if (!s || !neutral) return 0;
  return -(s.mx - neutral.mx) / neutral.sw;   // video is mirrored on screen, so flip the sign
}

function leanToSpeed(l) {
  const a = Math.abs(l);
  if (a < DEADZONE) return 0;
  const t = constrain((a - DEADZONE) / (FULL_LEAN - DEADZONE), 0, 1);
  return Math.sign(l) * t * MAX_VX;
}

// ---------- Game setup ----------
function newGame() {
  initAudio();
  startY = H - 120;
  player = { x: W / 2, y: startY, vx: 0, vy: JUMP, r: 18, squash: 0, face: 1 };
  plats = [{ x: W / 2 - PW / 2, y: H - 60, type: "normal", vx: 0 }];
  camY = 0; score = 0; topY = H - 60; particles = [];
  fillPlatforms();
  setMode("play");
}

function difficulty() { return Math.min(1, score / 4000); }

function fillPlatforms() {
  while (topY > camY - 200) {
    const d = difficulty();
    topY -= random(lerp(50, 70, d), lerp(80, 125, d));
    const r = Math.random();
    const type = r < 0.06 + 0.3 * d ? "move" : "normal";
    plats.push({
      x: random(0, W - PW), y: topY, type,
      vx: type === "move" ? random([-1, 1]) * (1 + 1.5 * d) : 0,
      spring: type === "normal" && Math.random() < 0.07,
    });
    // extra crumbly platform (never the only way up)
    if (Math.random() < 0.12 + 0.2 * d) {
      plats.push({ x: random(0, W - PW), y: topY + random(20, 45), type: "crumble", vx: 0, fall: 0 });
    }
  }
}

// ---------- Update ----------
function updateGame() {
  lean = readLean();
  let target = leanToSpeed(lean);
  if (keyIsDown(LEFT_ARROW)) target = -MAX_VX;
  if (keyIsDown(RIGHT_ARROW)) target = MAX_VX;
  player.vx += (target - player.vx) * 0.25;
  if (Math.abs(player.vx) > 0.5) player.face = Math.sign(player.vx);

  const prevBottom = player.y + player.r;
  player.vy += G;
  player.x += player.vx;
  player.y += player.vy;
  player.squash *= 0.85;

  // wrap around the sides
  if (player.x < -player.r) player.x = W + player.r;
  if (player.x > W + player.r) player.x = -player.r;

  for (const p of plats) {
    if (p.type === "move") { p.x += p.vx; if (p.x < 0 || p.x > W - PW) p.vx *= -1; }
    if (p.type === "crumble" && p.fall > 0) { p.fall += 0.5; p.y += p.fall; }
  }

  // land on platforms only while falling
  if (player.vy > 0) {
    const bottom = player.y + player.r;
    for (const p of plats) {
      if (p.fall > 0) continue;
      const overX = player.x > p.x - 10 && player.x < p.x + PW + 10;
      if (overX && prevBottom <= p.y + 2 && bottom >= p.y) {
        player.y = p.y - player.r;
        if (p.type === "crumble") {   // one bounce, then it breaks and falls
          player.vy = JUMP;
          player.squash = 1;
          p.fall = 1;
          puff(player.x, p.y, color(180, 170, 200));
          boing(200);
          break;
        }
        player.vy = p.spring ? SPRING : JUMP;
        player.squash = 1;
        puff(player.x, p.y, color(255));
        boing(p.spring ? 520 : 300);
        break;
      }
    }
  }

  // camera follows upward only
  if (player.y - camY < H * 0.4) camY = player.y - H * 0.4;
  score = Math.max(score, Math.floor((startY - player.y) / 8));

  fillPlatforms();
  plats = plats.filter(p => p.y < camY + H + 60);

  if (player.y - camY > H + 60) {
    if (score > best) { best = score; try { localStorage.setItem("skyhop-best", best); } catch (e) {} }
    boing(110, 0.5);
    setMode("over");
  }
}

// ---------- Draw ----------
function draw() {
  push();
  scale(scaleK);
  drawSky();
  if (mode === "play") updateGame();

  if (mode === "play" || mode === "over") {
    drawPlatforms();
    drawPlayer();
    drawParticles();
    drawScore();
    drawLeanMeter();
  }
  if (mode === "loading") overlay("SKY HOP", "Loading camera and body tracking…", "Allow camera access if your browser asks.");
  if (mode === "title") overlay("SKY HOP", "Lean left or right to steer.\nYou bounce on your own.", "Click or press Space to start");
  if (mode === "calibrate") drawCalibrate();
  if (mode === "over") overlay(`${score}`, `Best ${best}`, "Click or press Space to play again");
  pop();
}

function drawSky() {
  // sky darkens as you climb
  const h = mode === "play" || mode === "over" ? constrain(score / 6000, 0, 1) : 0;
  const top = lerpColor(color(255, 170, 120), color(40, 30, 90), h);
  const bot = lerpColor(color(255, 225, 170), color(110, 80, 160), h);
  noStroke();
  for (let y = 0; y < H; y += 8) { fill(lerpColor(top, bot, y / H)); rect(0, y, W, 8); }

  // faint camera feed behind the game
  if (camReady && mode !== "play") {
    const dh = H, dw = 640 * (H / 480);
    push();
    translate(W, 0); scale(-1, 1);   // mirror so it moves like a mirror
    tint(255, mode === "play" ? 45 : 90);
    image(video, (W - dw) / 2, 0, dw, dh);
    noTint();
    pop();
  }
}

function drawPlatforms() {
  for (const p of plats) {
    const y = p.y - camY;
    if (y < -30 || y > H + 30) continue;
    push();
    noStroke();
    if (p.type === "crumble") {
      fill(170, 160, 190, p.fall > 0 ? 120 : 230);
      rect(p.x, y, PW, PH, 8);
      stroke(110, 100, 130); strokeWeight(2);
      line(p.x + PW * 0.35, y + 2, p.x + PW * 0.45, y + PH - 2);
      line(p.x + PW * 0.65, y + 2, p.x + PW * 0.55, y + PH - 2);
    } else {
      fill(p.type === "move" ? color(170, 225, 255) : color(255));
      rect(p.x, y, PW, PH, 8);
      circle(p.x + 18, y + 2, 20); circle(p.x + 38, y - 2, 24); circle(p.x + 55, y + 3, 16);
      if (p.spring) {
        stroke(80, 60, 30); strokeWeight(2); noFill();
        for (let i = 0; i < 3; i++) line(p.x + 28, y - 4 - i * 5, p.x + 42, y - 6 - i * 5);
        noStroke(); fill(255, 205, 60); rect(p.x + 25, y - 20, 20, 5, 2);
      }
    }
    pop();
  }
}

function drawPlayer() {
  const x = player.x, y = player.y - camY, r = player.r;
  const sq = player.squash;

  // You as the character (falls back to the blob until the cutout is ready)
  if (cutout && crop) {
    const D = 84;
    push();
    translate(x, y + r);
    scale(-(1 + sq * 0.2), 1 - sq * 0.2);   // mirrored, with a little squash on bounce
    drawingContext.shadowColor = "rgba(255,255,255,0.9)";
    drawingContext.shadowBlur = 10;
    image(cutout, -D / 2, -D, D, D, crop.x, crop.y, crop.w, crop.h);
    pop();
    return;
  }

  push();
  translate(x, y);
  scale(1 + sq * 0.25, 1 - sq * 0.25);
  noStroke();
  fill(0, 0, 0, 40); ellipse(0, r + 2, r * 1.6, 6);
  fill(60, 200, 170); ellipse(0, 0, r * 2, r * 2.1);         // body
  fill(40, 160, 135); ellipse(-8, r - 2, 12, 8); ellipse(8, r - 2, 12, 8); // feet
  fill(255); ellipse(-6 + player.face * 3, -4, 12, 14); ellipse(8 + player.face * 3, -4, 12, 14);
  fill(30); circle(-6 + player.face * 5, -3, 6); circle(8 + player.face * 5, -3, 6);
  fill(255, 140, 120, 160); circle(-12, 6, 6); circle(14, 6, 6);  // cheeks
  pop();
}

function puff(x, y, c) {
  for (let i = 0; i < 8; i++) particles.push({ x, y, vx: random(-2, 2), vy: random(-1.5, 0.5), life: 1, c });
}

function drawParticles() {
  noStroke();
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.life -= 0.04;
    fill(red(p.c), green(p.c), blue(p.c), 200 * p.life);
    circle(p.x, p.y - camY, 6 * p.life + 2);
  }
  particles = particles.filter(p => p.life > 0);
}

function drawScore() {
  push();
  textAlign(LEFT, TOP); textSize(30); textStyle(BOLD);
  fill(0, 0, 0, 90); text(score, 16, 14);
  fill(255); text(score, 14, 12);
  textAlign(RIGHT, TOP); textSize(14); fill(255, 255, 255, 200);
  text(`BEST ${best}`, W - 14, 18);
  pop();
}

function drawLeanMeter() {
  const cx = W / 2, y = H - 26, w = 160;
  push();
  noStroke(); fill(0, 0, 0, 90); rect(cx - w / 2, y - 5, w, 10, 5);
  fill(255, 255, 255, 60); rect(cx - (DEADZONE / FULL_LEAN) * w / 2, y - 5, (DEADZONE / FULL_LEAN) * w, 10);
  const dx = constrain(lean / FULL_LEAN, -1, 1) * w / 2;
  fill(neutral && shoulders() ? color(60, 200, 170) : color(255, 90, 90));
  circle(cx + dx, y, 16);
  textAlign(CENTER, BOTTOM); textSize(11); fill(255, 255, 255, 200);
  text(neutral && shoulders() ? "LEAN" : "CAN'T SEE YOU", cx, y - 9);
  pop();
}

function drawCalibrate() {
  const s = shoulders();
  if (s) calBuf.push(s); else calBuf = [];
  const prog = calBuf.length / 40;
  overlay("GET SET", s ? "Hold still, centered…" : "I can't see your shoulders.\nMove so your upper body is on camera.", "");
  push();
  noStroke(); fill(0, 0, 0, 100); rect(W / 2 - 100, H * 0.62, 200, 10, 5);
  fill(60, 200, 170); rect(W / 2 - 100, H * 0.62, 200 * Math.min(1, prog), 10, 5);
  pop();
  if (calBuf.length >= 40) {
    const n = calBuf.length;
    neutral = { mx: calBuf.reduce((a, b) => a + b.mx, 0) / n, sw: calBuf.reduce((a, b) => a + b.sw, 0) / n };
    calBuf = [];
    newGame();
  }
}

function overlay(title, sub, hint) {
  push();
  noStroke(); fill(30, 20, 60, 130); rect(0, 0, W, H);
  textAlign(CENTER, CENTER); textStyle(BOLD);
  textSize(54); fill(0, 0, 0, 80); text(title, W / 2 + 3, H * 0.34 + 4);
  fill(255, 247, 232); text(title, W / 2, H * 0.34);
  textStyle(NORMAL); textSize(20); text(sub, W / 2, H * 0.48);
  textSize(15); fill(255, 220, 140); text(hint, W / 2, H * 0.7);
  pop();
}

// ---------- Input ----------
function startOrRestart() {
  if (mode === "title") { initAudio(); calBuf = []; setMode("calibrate"); }
  else if (mode === "over") newGame();
}
function mousePressed() { startOrRestart(); }
function keyPressed() {
  if (key === " ") startOrRestart();
  if ((key === "c" || key === "C") && mode !== "loading") { neutral = null; calBuf = []; setMode("calibrate"); }
}

// ---------- Sound ----------
let actx = null;
function initAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} }
function boing(f, d = 0.15) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
  o.type = "sine";
  o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2, t + d);
  g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
}