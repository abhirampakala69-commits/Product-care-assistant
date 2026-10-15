/* ==========================================================================
   CareOrbit AI — Cinematic 3D Intro Experience
   Features:
   - High-performance canvas particle dynamics with 3D projection
   - 7-stage choreography: cosmic drift -> orbital singularity -> emblem assembly -> cyan light sweep -> wordmark emergence -> tagline tracking -> bloom aperture reveal
   - Keyboard accessible [Esc] & Skip button
   - Preference persistence & prefers-reduced-motion support
   ========================================================================== */

(function () {
  const STORAGE_KEY_SEEN = "careorbit_intro_seen";
  const STORAGE_KEY_DISABLED = "careorbit_disable_intro";

  const overlay = document.getElementById("intro-overlay");
  const canvas = document.getElementById("intro-canvas");
  const skipBtn = document.getElementById("skip-intro-btn");
  const titleEl = document.getElementById("intro-title");
  const taglineEl = document.getElementById("intro-tagline");

  if (!overlay || !canvas) return;

  const ctx = canvas.getContext("2d");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isIntroDisabled = localStorage.getItem(STORAGE_KEY_DISABLED) === "true";
  const hasSeenIntro = localStorage.getItem(STORAGE_KEY_SEEN) === "true";

  let animId = null;
  let startTime = null;
  let isDismissed = false;
  let W = 0, H = 0, dpr = 1;

  // 3D Particles definition
  const PARTICLE_COUNT = 750;
  const particles = [];

  // Generate targets on the 3D CareOrbit Emblem:
  // 1. Central core sphere
  // 2. Inner tilted orbital ring
  // 3. Outer tilted counter-ring
  // 4. Protective orbital shield contour
  function generateEmblemTargets() {
    const targets = [];
    
    // Core (150 pts)
    for (let i = 0; i < 150; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = Math.cbrt(Math.random()) * 26;
      const sinPhi = Math.sin(phi);
      targets.push({
        x: r * sinPhi * Math.cos(theta),
        y: r * sinPhi * Math.sin(theta),
        z: r * Math.cos(phi),
        color: "#ffffff",
        size: 1.6 + Math.random() * 1.4,
        part: "core"
      });
    }

    // Ring 1: tilted 45 deg on X, 25 deg on Y (200 pts)
    for (let i = 0; i < 200; i++) {
      const angle = (i / 200) * Math.PI * 2;
      const rx = 85 + (Math.random() - 0.5) * 6;
      const ry = 85 + (Math.random() - 0.5) * 6;
      // 3D rotation
      const x0 = Math.cos(angle) * rx;
      const y0 = Math.sin(angle) * ry * 0.42;
      const z0 = Math.sin(angle) * 55;
      targets.push({
        x: x0,
        y: y0,
        z: z0,
        color: "#00f0ff",
        size: 1.2 + Math.random() * 1.5,
        part: "ring1"
      });
    }

    // Ring 2: counter-tilted (200 pts)
    for (let i = 0; i < 200; i++) {
      const angle = (i / 200) * Math.PI * 2;
      const rx = 105 + (Math.random() - 0.5) * 8;
      const ry = 105 + (Math.random() - 0.5) * 8;
      const x0 = Math.cos(angle) * rx;
      const y0 = -Math.sin(angle) * ry * 0.45;
      const z0 = -Math.sin(angle) * 65;
      targets.push({
        x: x0,
        y: y0,
        z: z0,
        color: "#818cf8",
        size: 1.2 + Math.random() * 1.4,
        part: "ring2"
      });
    }

    // Outer shield arc & crown (200 pts)
    for (let i = 0; i < 200; i++) {
      const angle = (i / 200) * Math.PI * 2;
      const r = 135 + (Math.random() - 0.5) * 8;
      const x0 = Math.cos(angle) * r;
      // Shield geometry taper
      const taper = 1 - 0.15 * Math.sin(angle);
      const y0 = Math.sin(angle) * r * taper;
      const z0 = (Math.random() - 0.5) * 20;
      targets.push({
        x: x0,
        y: y0,
        z: z0,
        color: i % 2 === 0 ? "#00f0ff" : "#38bdf8",
        size: 1.4 + Math.random() * 1.6,
        part: "shield"
      });
    }

    return targets;
  }

  const targets = generateEmblemTargets();

  // Initialize chaotic cosmic swarm particles
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const t = targets[i % targets.length];
    // Start anywhere in wide 3D space
    const radius = 250 + Math.random() * 600;
    const theta = Math.random() * Math.PI * 2;
    const phi = (Math.random() - 0.5) * Math.PI;

    particles.push({
      x: radius * Math.cos(theta) * Math.cos(phi),
      y: radius * Math.sin(phi),
      z: radius * Math.sin(theta) * Math.cos(phi),
      tx: t.x,
      ty: t.y,
      tz: t.z,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      vz: (Math.random() - 0.5) * 1.5,
      color: t.color,
      baseSize: t.size,
      orbitSpeed: 0.8 + Math.random() * 1.6,
      orbitRadius: 80 + Math.random() * 220,
      orbitAngle: Math.random() * Math.PI * 2,
      delay: Math.random() * 0.5
    });
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  function dismissIntro(immediate = false) {
    if (isDismissed) return;
    isDismissed = true;
    localStorage.setItem(STORAGE_KEY_SEEN, "true");

    if (animId) cancelAnimationFrame(animId);

    if (immediate || reducedMotion) {
      overlay.style.display = "none";
      overlay.classList.add("dismissed");
    } else {
      overlay.classList.add("dismissed");
      setTimeout(() => {
        overlay.style.display = "none";
      }, 850);
    }

    // Trigger dashboard reveal entrance hooks if present
    window.dispatchEvent(new CustomEvent("careorbit:intro-finished"));
  }

  // Allow manual replay from UI button
  window.replayIntro = function () {
    isDismissed = false;
    overlay.style.display = "flex";
    overlay.classList.remove("dismissed");
    titleEl.classList.remove("revealed");
    taglineEl.classList.remove("revealed");
    startTime = null;
    resize();
    animId = requestAnimationFrame(render);
  };

  // Keyboard shortcut: Esc or Space to skip immediately
  window.addEventListener("keydown", (e) => {
    if (!isDismissed && (e.key === "Escape" || e.code === "Space")) {
      e.preventDefault();
      dismissIntro();
    }
  });

  if (skipBtn) {
    skipBtn.addEventListener("click", () => dismissIntro());
  }

  // Animation render loop
  function render(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = (timestamp - startTime) / 1000; // seconds

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Deep space background with subtle trail blur
    ctx.fillStyle = "rgba(3, 6, 13, 0.28)";
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 - 25; // Slightly above center to accommodate text

    // Camera perspective parameters
    const fov = 420;
    const rotSpeed = 0.45;
    const rotY = elapsed * rotSpeed;
    const rotX = 0.28 + Math.sin(elapsed * 0.5) * 0.12;

    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);

    // Timeline phases:
    // 0.0s - 1.2s: Cosmic swirling singularity
    // 1.2s - 2.8s: Assembly into emblem
    // 2.8s - 3.8s: Light sweep across emblem
    // 3.4s - 4.4s: Title text & tagline emergence
    // 4.8s - 5.5s: Zoom bloom & dissolve
    const assembleProgress = Math.min(1, Math.max(0, (elapsed - 1.0) / 1.6));
    const easeAssemble = 1 - Math.pow(1 - assembleProgress, 3);

    // Light sweep wave calculation
    const isSweeping = elapsed >= 2.6 && elapsed <= 4.0;
    const sweepProgress = isSweeping ? (elapsed - 2.6) / 1.4 : -1;
    const sweepX = (sweepProgress - 0.5) * 360; // travels from -180 to +180

    // Typography reveals
    if (elapsed > 3.0 && !titleEl.classList.contains("revealed")) {
      titleEl.classList.add("revealed");
    }
    if (elapsed > 3.4 && !taglineEl.classList.contains("revealed")) {
      taglineEl.classList.add("revealed");
    }

    // Auto-complete intro at 5.2 seconds
    if (elapsed >= 5.2) {
      dismissIntro();
      return;
    }

    // Sort particles by depth for correct 3D rendering
    const projectedParticles = [];

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // Swirl state
      p.orbitAngle += p.orbitSpeed * 0.04;
      const swirlX = Math.cos(p.orbitAngle) * p.orbitRadius;
      const swirlY = Math.sin(p.orbitAngle * 0.7) * (p.orbitRadius * 0.4);
      const swirlZ = Math.sin(p.orbitAngle) * p.orbitRadius;

      // Interpolate between swirling orbit and structured 3D emblem
      const curX = swirlX * (1 - easeAssemble) + p.tx * easeAssemble;
      const curY = swirlY * (1 - easeAssemble) + p.ty * easeAssemble;
      const curZ = swirlZ * (1 - easeAssemble) + p.tz * easeAssemble;

      // Rotate around center
      const x1 = curX * cosY + curZ * sinY;
      const z1 = -curX * sinY + curZ * cosY;
      const y1 = curY * cosX - z1 * sinX;
      const z2 = curY * sinX + z1 * cosX;

      // 3D Perspective projection
      const cameraDist = 450;
      const pScale = fov / (cameraDist - z2);
      const projX = cx + x1 * pScale;
      const projY = cy + y1 * pScale;
      const alpha = Math.max(0.15, Math.min(1, (z2 + 200) / 400));

      // Light sweep photon flash bonus
      let sweepBonus = 0;
      if (isSweeping && easeAssemble > 0.8) {
        const distFromSweep = Math.abs(x1 - sweepX);
        if (distFromSweep < 45) {
          sweepBonus = (1 - distFromSweep / 45) * 1.5;
        }
      }

      projectedParticles.push({
        x: projX,
        y: projY,
        z: z2,
        size: p.baseSize * pScale * (1 + sweepBonus * 0.6),
        color: sweepBonus > 0.4 ? "#ffffff" : p.color,
        alpha: Math.min(1, alpha + sweepBonus * 0.5),
        bonus: sweepBonus
      });
    }

    // Sort by Z (back to front)
    projectedParticles.sort((a, b) => a.z - b.z);

    // Draw central ambient glow
    if (easeAssemble > 0.3) {
      const coreGlow = ctx.createRadialGradient(cx, cy, 5, cx, cy, 140 * easeAssemble);
      coreGlow.addColorStop(0, "rgba(0, 240, 255, 0.28)");
      coreGlow.addColorStop(0.5, "rgba(129, 140, 248, 0.12)");
      coreGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, 140 * easeAssemble, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw light sweep beam flare
    if (isSweeping) {
      const beamX = cx + sweepX * cosY;
      const sweepGrad = ctx.createLinearGradient(beamX - 40, cy - 120, beamX + 40, cy + 120);
      sweepGrad.addColorStop(0, "rgba(0, 240, 255, 0)");
      sweepGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.35)");
      sweepGrad.addColorStop(1, "rgba(0, 240, 255, 0)");
      ctx.fillStyle = sweepGrad;
      ctx.fillRect(beamX - 30, cy - 140, 60, 280);
    }

    // Render particles
    for (const p of projectedParticles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, p.size), 0, Math.PI * 2);
      ctx.fill();

      // Specular glow halo on sweep
      if (p.bonus > 0.6) {
        ctx.fillStyle = "rgba(0, 240, 255, 0.35)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1.0;
    animId = requestAnimationFrame(render);
  }

  // Decision logic: show intro or skip based on user's history/preferences
  if (reducedMotion || isIntroDisabled || hasSeenIntro) {
    dismissIntro(true);
  } else {
    // Start intro sequence
    animId = requestAnimationFrame(render);
    // Absolute fallback safety timeout (in case requestAnimationFrame fails)
    setTimeout(() => {
      if (!isDismissed) dismissIntro();
    }, 6500);
  }
})();
