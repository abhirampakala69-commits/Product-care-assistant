/* ==========================================================================
   CareOrbit AI — Main Application Controller
   Brand: CareOrbit AI | Tagline: Intelligence beyond the purchase.
   ========================================================================== */

   (function () {
    "use strict";
  
    // ---------------------------------------------------------------------------
    // Application State
    // ---------------------------------------------------------------------------
    const state = {
      products: [],
      careSummary: null,
      serviceRequests: [],
      maintenanceTasks: [],
      serviceHistory: [],
      activeTab: "overview",
      searchQuery: "",
      productFilter: "all",
      productSort: "expiry",
      selectedProductContext: null,
      sessionId: null,
      isChatBusy: false,
      awaitingApproval: false,
      isRecording: false,
      isSpeaking: false,
      lastWasVoice: false,
      transcript: [],
      dismissedBannerId: null,
      theme: localStorage.getItem("careorbit_theme") || "dark"
    };
  
    try {
      state.sessionId = sessionStorage.getItem("careorbit_session");
    } catch (e) {}
  
    // ---------------------------------------------------------------------------
    // DOM Elements Selector Helper
    // ---------------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const $$ = (sel) => document.querySelectorAll(sel);
  
    // ---------------------------------------------------------------------------
    // Date & Currency Utilities (India Timezone)
    // ---------------------------------------------------------------------------
    const todayISO = () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
  
    const dayNum = (iso) => Date.parse(iso + "T00:00:00Z") / 86400000;
  
    function addMonths(iso, months) {
      const d = new Date(iso + "T00:00:00Z");
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return d.toISOString().slice(0, 10);
    }
  
    function warrantyOf(p) {
      const expiry = addMonths(p.purchaseDate || p.purchase_date, p.warrantyMonths ?? p.warranty_months ?? 12);
      const purchase = p.purchaseDate || p.purchase_date;
      const left = Math.round(dayNum(expiry) - dayNum(todayISO()));
      const total = Math.max(1, Math.round(dayNum(expiry) - dayNum(purchase)));
      const colour = left <= 30 ? "var(--danger)" : left <= 90 ? "var(--warn)" : "var(--ok)";
      return {
        expiry,
        left,
        total,
        fraction: Math.max(0, Math.min(1, left / total)),
        colour,
        isExpired: left < 0,
        isExpiringSoon: left >= 0 && left <= 90
      };
    }
  
    const prettyDate = (iso) => {
      if (!iso) return "N/A";
      try {
        return new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC"
        });
      } catch {
        return iso;
      }
    };
  
    const rupees = (num) => "₹" + Number(num || 0).toLocaleString("en-IN");
  
    const compactRupees = (num) => {
      try {
        return new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          notation: "compact",
          maximumFractionDigits: 1
        }).format(num || 0);
      } catch {
        return rupees(num);
      }
    };
  
    // ---------------------------------------------------------------------------
    // Toast System
    // ---------------------------------------------------------------------------
    function showToast(message, type = "info") {
      const container = $("toast-container");
      if (!container) return;
  
      const toast = document.createElement("div");
      toast.className = `toast-msg ${type}`;
      toast.textContent = message;
      container.appendChild(toast);
  
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 350);
      }, 2800);
    }
  
    // ---------------------------------------------------------------------------
    // Theme Toggle
    // ---------------------------------------------------------------------------
    function applyTheme(t) {
      state.theme = t;
      if (t === "light") {
        document.documentElement.dataset.theme = "light";
      } else {
        delete document.documentElement.dataset.theme;
      }
      localStorage.setItem("careorbit_theme", t);
      setOrbState(orbStateName);
    }
  
    const themeBtn = $("theme-toggle-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        applyTheme(state.theme === "light" ? "dark" : "light");
        showToast(`Switched to ${state.theme === "light" ? "Light" : "Midnight Dark"} mode`);
      });
    }
  
    // ---------------------------------------------------------------------------
    // Tab Navigation Routing
    // ---------------------------------------------------------------------------
    function switchTab(tabId) {
      if (!tabId) return;
      state.activeTab = tabId;
  
      $$(".nav-item").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabId);
      });
  
      $$(".view-pane").forEach((pane) => {
        pane.classList.toggle("active", pane.id === `view-${tabId}`);
      });
  
      // Close mobile sidebar if open
      const sidebar = $("app-sidebar");
      if (sidebar) sidebar.classList.remove("mobile-open");
  
      // Scroll main viewport to top
      const mainEl = $("main-viewport");
      if (mainEl) mainEl.scrollTop = 0;
  
      // Refresh context if opening copilot or warranty
      if (tabId === "copilot") {
        updateCopilotContextUI();
      } else if (tabId === "warranty") {
        renderWarrantyCenter();
      } else if (tabId === "services") {
        loadServiceRequests();
      } else if (tabId === "appointments") {
        loadAppointments();
      } else if (tabId === "maintenance") {
        loadMaintenance();
      } else if (tabId === "history") {
        loadServiceHistory();
      }
    }
  
    $$(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        const tab = item.dataset.tab;
        if (tab) switchTab(tab);
      });
    });
  
    // Collapsible Sidebar toggle
    const collapseBtn = $("sidebar-collapse-btn");
    const shell = $("app-shell");
    if (collapseBtn && shell) {
      collapseBtn.addEventListener("click", () => {
        shell.classList.toggle("sidebar-collapsed");
      });
    }
  
    // Mobile menu button
    const mobileMenuBtn = $("mobile-menu-btn");
    if (mobileMenuBtn) {
      mobileMenuBtn.addEventListener("click", () => {
        $("app-sidebar").classList.toggle("mobile-open");
      });
    }
  
    // ---------------------------------------------------------------------------
    // 3D Holographic Orb (Visualizer for AI Care Copilot)
    // ---------------------------------------------------------------------------
    const ORB_CONFIGS = {
      idle: { spin: 0.0028, amp: 0.03, speed: 1.2, pulse: 0.015, label: "Copilot Ready", col: [0, 240, 255] },
      listening: { spin: 0.006, amp: 0.08, speed: 3.5, pulse: 0.06, label: "Listening to Voice...", col: [0, 255, 180] },
      thinking: { spin: 0.022, amp: 0.11, speed: 6.0, pulse: 0.025, label: "Analyzing Product Care...", col: [129, 140, 248] },
      speaking: { spin: 0.009, amp: 0.14, speed: 7.0, pulse: 0.04, label: "Speaking...", col: [56, 189, 248] },
      approval: { spin: 0.003, amp: 0.04, speed: 1.8, pulse: 0.02, label: "Awaiting Action Approval", col: [245, 158, 11] }
    };
  
    const orbCanvas = $("copilot-orb-canvas");
    const orbCtx = orbCanvas ? orbCanvas.getContext("2d") : null;
    const orbLabel = $("copilot-orb-status-text");
  
    let orbStateName = "idle";
    let curOrb = { ...ORB_CONFIGS.idle };
    let targetOrb = { ...ORB_CONFIGS.idle };
    let orbRot = 0.5;
    let orbTiltX = 0.25;
    let orbAimX = 0.25;
    let orbW = 0, orbH = 0, orbDpr = 1;
  
    // 1000 Fibonacci sphere points
    const orbPts = [];
    const ORB_POINTS = 900;
    for (let i = 0; i < ORB_POINTS; i++) {
      const y = 1 - (i / (ORB_POINTS - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = Math.PI * (3 - Math.sqrt(5)) * i;
      orbPts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * 6.28 });
    }
  
    function setOrbState(name) {
      orbStateName = name;
      targetOrb = { ...ORB_CONFIGS[name] };
      if (orbLabel) orbLabel.textContent = ORB_CONFIGS[name].label;
    }
  
    function resizeOrb() {
      if (!orbCanvas) return;
      orbDpr = Math.min(window.devicePixelRatio || 1, 2);
      orbW = orbCanvas.clientWidth;
      orbH = orbCanvas.clientHeight;
      orbCanvas.width = Math.round(orbW * orbDpr);
      orbCanvas.height = Math.round(orbH * orbDpr);
    }
  
    const orbBuckets = [[], [], [], []];
  
    function drawOrb(t) {
      if (!orbCtx || !orbW) return;
      orbCtx.setTransform(orbDpr, 0, 0, orbDpr, 0, 0);
      orbCtx.clearRect(0, 0, orbW, orbH);
  
      const time = t / 1000;
      const cx = orbW / 2;
      const cy = orbH / 2;
      const R = Math.min(orbW, orbH) * 0.36 * (1 + curOrb.pulse * Math.sin(time * 5));
      const colStr = `${Math.round(curOrb.col[0])},${Math.round(curOrb.col[1])},${Math.round(curOrb.col[2])}`;
  
      // Glow halo
      const glow = orbCtx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.4);
      glow.addColorStop(0, `rgba(${colStr}, 0.22)`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      orbCtx.fillStyle = glow;
      orbCtx.fillRect(0, 0, orbW, orbH);
  
      const cosY = Math.cos(orbRot), sinY = Math.sin(orbRot);
      const cosX = Math.cos(orbTiltX), sinX = Math.sin(orbTiltX);
      const scale = R / 105;
  
      orbBuckets.forEach((b) => (b.length = 0));
  
      for (const p of orbPts) {
        const k = 1 + Math.sin(p.y * 5 + time * curOrb.speed + p.seed * 0.3) * curOrb.amp;
        const x = p.x * k, y = p.y * k, z = p.z * k;
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        const y1 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;
        const persp = 2.6 / (2.6 - z2);
        const depth = (z2 + 1.2) / 2.4;
        const size = (0.7 + depth * 1.6) * scale;
        const bIdx = Math.max(0, Math.min(3, Math.floor(depth * 4)));
        orbBuckets[bIdx].push(cx + x1 * R * persp, cy - y1 * R * persp, size);
      }
  
      for (let b = 0; b < 4; b++) {
        const list = orbBuckets[b];
        orbCtx.fillStyle = `rgba(${colStr}, ${(0.18 + b * 0.26).toFixed(2)})`;
        orbCtx.beginPath();
        for (let i = 0; i < list.length; i += 3) {
          orbCtx.moveTo(list[i] + list[i + 2], list[i + 1]);
          orbCtx.arc(list[i], list[i + 1], list[i + 2], 0, 6.283);
        }
        orbCtx.fill();
      }
    }
  
    function orbLoop(t) {
      for (const key of ["spin", "amp", "speed", "pulse"]) {
        curOrb[key] += (targetOrb[key] - curOrb[key]) * 0.08;
      }
      for (let i = 0; i < 3; i++) {
        curOrb.col[i] += (targetOrb.col[i] - curOrb.col[i]) * 0.08;
      }
      orbRot += curOrb.spin;
      orbTiltX += (orbAimX - orbTiltX) * 0.05;
      drawOrb(t);
      requestAnimationFrame(orbLoop);
    }
  
    if (orbCanvas) {
      new ResizeObserver(resizeOrb).observe(orbCanvas);
      resizeOrb();
      requestAnimationFrame(orbLoop);
    }
  
    function refreshOrb() {
      if (state.isRecording) {
        setOrbState("listening");
      } else if (state.isChatBusy) {
        setOrbState("thinking");
      } else if (state.isSpeaking) {
        setOrbState("speaking");
      } else if (state.awaitingApproval) {
        setOrbState("approval");
      } else {
        setOrbState("idle");
      }
    }
  
    // ---------------------------------------------------------------------------
    // Data Fetching: Products, Care Summary, Requests, Maintenance
    // ---------------------------------------------------------------------------
    function updateAppointmentProductList() {
      const sel = $("appointment-check-product");
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = "";
      state.products.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.brand})`;
        sel.appendChild(opt);
      });
      if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    }
  
    async function loadProducts() {
      try {
        const res = await fetch("/api/products");
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        state.products = data.products || [];
        renderOverviewMetrics();
        renderProductsGrid();
        updateUrgentBanner();
        updateCopilotProductContextList();
        updateAppointmentProductList();
        updateNotificationBadge();
      } catch (e) {
        console.warn("Could not load products:", e.message);
      }
    }
  
    async function loadCareSummary() {
      try {
        const res = await fetch("/api/care-summary");
        if (!res.ok) throw new Error("bad status");
        state.careSummary = await res.json();
        renderCareSummaryHero();
      } catch (e) {
        console.warn("Could not load care summary:", e.message);
      }
    }
  
    async function loadServiceRequests() {
      try {
        const res = await fetch("/api/service-requests");
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        state.serviceRequests = data.serviceRequests || [];
        renderServiceRequests();
      } catch (e) {
        console.warn("Could not load service requests:", e.message);
      }
    }
  
    async function loadAppointments() {
      try {
        const res = await fetch("/api/care-summary");
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        const appointments = data.upcomingAppointments || [];
        renderAppointments(appointments);
      } catch (e) {
        console.warn("Could not load appointments:", e.message);
      }
    }
  
    async function loadMaintenance() {
      try {
        const res = await fetch("/api/maintenance?daysAhead=60");
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        state.maintenanceTasks = data.tasks || [];
        renderMaintenance();
      } catch (e) {
        console.warn("Could not load maintenance:", e.message);
      }
    }
  
    async function loadServiceHistory() {
      try {
        const res = await fetch("/api/service-history");
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        state.serviceHistory = data.serviceHistory || [];
        renderServiceHistory();
      } catch (e) {
        console.warn("Could not load history:", e.message);
      }
    }
  
    async function checkSystemHealth() {
      const dot = $("system-status-dot");
      const txt = $("system-status-text");
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (dot) dot.className = `status-indicator-dot ${data.ready ? "online" : "offline"}`;
        if (txt) txt.textContent = data.ready ? "CareOrbit Online" : "Starting Engines";
      } catch {
        if (dot) dot.className = "status-indicator-dot offline";
        if (txt) txt.textContent = "Offline";
      }
    }
  
    // ---------------------------------------------------------------------------
    // View 1: Overview Dashboard Rendering
    // ---------------------------------------------------------------------------
    function renderOverviewMetrics() {
      const info = state.products.map(warrantyOf);
      const totalProducts = state.products.length;
      const expiringSoon = info.filter((w) => w.isExpiringSoon).length;
      const ended = info.filter((w) => w.isExpired).length;
      const active = totalProducts - ended;
      const totalValue = state.products.reduce((acc, p) => acc + (Number(p.purchasePrice || p.purchase_price || p.price) || 0), 0);
  
      const elTotal = $("stat-products-count");
      const elActive = $("stat-active-warranties");
      const elSoon = $("stat-soon-warranties");
      const elValue = $("stat-portfolio-value");
  
      if (elTotal) elTotal.textContent = String(totalProducts);
      if (elActive) elActive.textContent = String(active);
      if (elSoon) elSoon.textContent = String(expiringSoon);
      if (elValue) elValue.textContent = compactRupees(totalValue);
  
      // Calculate household health score (0-100%)
      let healthScore = 100;
      if (totalProducts > 0) {
        const expiredPenalty = (ended / totalProducts) * 30;
        const soonPenalty = (expiringSoon / totalProducts) * 15;
        healthScore = Math.max(35, Math.round(100 - expiredPenalty - soonPenalty));
      }
      const scoreEl = $("overview-health-score");
      const ringEl = $("health-ring-val");
      if (scoreEl) scoreEl.textContent = `${healthScore}%`;
      if (ringEl) {
        const circ = 2 * Math.PI * 38; // r=38
        const offset = circ * (1 - healthScore / 100);
        ringEl.style.strokeDasharray = circ;
        ringEl.style.strokeDashoffset = offset;
        ringEl.style.stroke = healthScore > 80 ? "var(--ok)" : healthScore > 60 ? "var(--warn)" : "var(--danger)";
      }
    }
  
    function renderCareSummaryHero() {
      if (!state.careSummary) return;
      const heroText = $("hero-spoken-summary");
      if (heroText && state.careSummary.spokenSummary) {
        heroText.textContent = state.careSummary.spokenSummary;
      }
    }
  
    function updateUrgentBanner() {
      const banner = $("urgent-alert-banner");
      if (!banner) return;
  
      const urgent = state.products
        .map((p) => ({ p, w: warrantyOf(p) }))
        .filter((x) => x.w.left >= 0 && x.w.left <= 30)
        .sort((a, b) => a.w.left - b.w.left)[0];
  
      if (!urgent || state.dismissedBannerId === urgent.p.id) {
        banner.style.display = "none";
        return;
      }
  
      banner.style.display = "flex";
      const title = $("urgent-banner-title");
      const desc = $("urgent-banner-desc");
      const days = urgent.w.left;
  
      if (title) title.textContent = `Warranty Expiry Alert: ${urgent.p.name}`;
      if (desc) {
        desc.textContent = `Standard warranty expires ${days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days"}. Review your coverage or file a claim before expiry.`;
      }
  
      const detailsBtn = $("urgent-btn-details");
      const claimBtn = $("urgent-btn-claim");
      const dismissBtn = $("urgent-btn-dismiss");
  
      if (detailsBtn) {
        detailsBtn.onclick = () => openProductDrawer(urgent.p);
      }
      if (claimBtn) {
        claimBtn.onclick = () => {
          switchTab("copilot");
          fillCopilotInput(`Draft a warranty claim for my ${urgent.p.name} (product ID ${urgent.p.id}). The issue is: `);
        };
      }
      if (dismissBtn) {
        dismissBtn.onclick = () => {
          state.dismissedBannerId = urgent.p.id;
          banner.style.display = "none";
        };
      }
    }
  
    // ---------------------------------------------------------------------------
    // View 2: My Products Management (3D Tilt Cards)
    // ---------------------------------------------------------------------------
    function attach3DTilt(card) {
      card.addEventListener("mousemove", (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const rotX = ((y - cy) / cy) * -6;
        const rotY = ((x - cx) / cx) * 6;
  
        card.style.transform = `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) translateY(-2px)`;
        card.style.setProperty("--mouse-x", `${x}px`);
        card.style.setProperty("--mouse-y", `${y}px`);
      });
  
      card.addEventListener("mouseleave", () => {
        card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0)";
      });
    }
  
    function makeProductCard(p) {
      const w = warrantyOf(p);
      const price = p.purchasePrice || p.purchase_price || p.price;
      const card = document.createElement("div");
      card.className = "product-card-3d";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `${p.name} by ${p.brand}. Warranty status: ${w.left < 0 ? "Expired" : w.left + " days remaining"}`);
  
      const circ = 2 * Math.PI * 23;
      const offset = circ * (1 - w.fraction);
  
      card.innerHTML = `
        <div class="product-card-sheen"></div>
        <div class="product-card-top">
          <span class="product-category-tag">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            ${p.category || "General"}
          </span>
          <div class="warranty-dial-sm">
            <svg class="warranty-dial-svg" viewBox="0 0 58 58">
              <circle cx="29" cy="29" r="23" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="5" />
              <circle class="warranty-dial-val" cx="29" cy="29" r="23" stroke="${w.colour}" style="stroke-dasharray: ${circ}; stroke-dashoffset: ${offset};" />
            </svg>
            <div class="warranty-dial-inner">
              <span class="warranty-dial-num" style="color: ${w.colour};">${w.left < 0 ? "EXP" : w.left >= 365 ? (w.left / 365).toFixed(1) + "y" : w.left}</span>
              <span class="warranty-dial-unit">${w.left < 0 ? "ended" : w.left >= 365 ? "rem" : "days"}</span>
            </div>
          </div>
        </div>
        <h3 class="product-name-title">${p.name}</h3>
        <p class="product-brand-line">${p.brand}${p.modelNumber || p.model_number ? " · " + (p.modelNumber || p.model_number) : ""}</p>
        <div class="product-specs-meta">
          <div class="spec-cell">
            <small>Purchase Date</small>
            <span>${prettyDate(p.purchaseDate || p.purchase_date)}</span>
          </div>
          <div class="spec-cell">
            <small>Warranty Expiry</small>
            <span style="color: ${w.colour};">${prettyDate(w.expiry)}</span>
          </div>
          <div class="spec-cell">
            <small>Purchase Price</small>
            <span>${rupees(price)}</span>
          </div>
          <div class="spec-cell">
            <small>Status</small>
            <span style="color: ${w.colour};">${w.left < 0 ? "Expired" : w.left <= 30 ? "Ending Soon" : "Active"}</span>
          </div>
        </div>
        <div class="product-card-actions">
          <button type="button" class="card-action-btn btn-view-details">Inspect Details</button>
          <button type="button" class="card-action-btn highlight btn-card-troubleshoot">Troubleshoot</button>
        </div>
      `;
  
      attach3DTilt(card);
  
      // Click handler for card
      card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-card-troubleshoot")) {
          e.stopPropagation();
          switchTab("copilot");
          fillCopilotInput(`My ${p.name} has an issue: `);
        } else {
          openProductDrawer(p);
        }
      });
  
      return card;
    }
  
    function renderProductsGrid() {
      const grid = $("products-grid-container");
      if (!grid) return;
  
      const q = state.searchQuery.trim().toLowerCase();
      let list = state.products.filter((p) => {
        const w = warrantyOf(p);
        if (state.productFilter === "soon" && !w.isExpiringSoon) return false;
        if (state.productFilter === "ended" && !w.isExpired) return false;
        if (state.productFilter !== "all" && state.productFilter !== "soon" && state.productFilter !== "ended") {
          if ((p.category || "").toLowerCase() !== state.productFilter.toLowerCase()) return false;
        }
        return !q || `${p.name} ${p.brand} ${p.category || ""}`.toLowerCase().includes(q);
      });
  
      // Sorting
      list.sort((a, b) => {
        const wa = warrantyOf(a);
        const wb = warrantyOf(b);
        if (state.productSort === "expiry") {
          return wa.left - wb.left;
        } else if (state.productSort === "price-desc") {
          return (Number(b.purchasePrice || b.purchase_price) || 0) - (Number(a.purchasePrice || a.purchase_price) || 0);
        } else if (state.productSort === "name") {
          return a.name.localeCompare(b.name);
        }
        return 0;
      });
  
      if (!state.products.length) {
        grid.innerHTML = `
          <div class="empty-state-card">
            <div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>
            <h3>No Registered Products Yet</h3>
            <p style="color: var(--text-muted); max-width: 420px;">Protect your household purchases. Register an appliance, electronic device, or vehicle to track warranties and receive automated care reminders.</p>
            <button type="button" class="primary-action-btn" id="empty-add-product-btn">Register Your First Product</button>
          </div>
        `;
        const btn = $("empty-add-product-btn");
        if (btn) btn.onclick = openAddProductModal;
        return;
      }
  
      if (!list.length) {
        grid.innerHTML = `
          <div class="empty-state-card">
            <h3>No matching products found</h3>
            <p style="color: var(--text-muted);">Try adjusting your search query or filter settings.</p>
          </div>
        `;
        return;
      }
  
      grid.replaceChildren(...list.map(makeProductCard));
    }
  
    // Filter chips listener
    $$(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$(".filter-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.productFilter = chip.dataset.filter || "all";
        renderProductsGrid();
      });
    });
  
    // Search input listener
    const searchField = $("product-search-field");
    if (searchField) {
      searchField.addEventListener("input", (e) => {
        state.searchQuery = e.target.value;
        renderProductsGrid();
      });
    }
  
    // Sort dropdown
    const sortSelect = $("product-sort-select");
    if (sortSelect) {
      sortSelect.addEventListener("change", (e) => {
        state.productSort = e.target.value;
        renderProductsGrid();
      });
    }
  
    // ---------------------------------------------------------------------------
    // Product Detail Drawer
    // ---------------------------------------------------------------------------
    function openProductDrawer(p) {
      const drawer = $("product-detail-drawer");
      if (!drawer) return;
  
      const w = warrantyOf(p);
      const title = $("drawer-product-title");
      const sub = $("drawer-product-sub");
      const timeline = $("drawer-warranty-timeline");
      const specs = $("drawer-specs-list");
      const actions = $("drawer-action-buttons");
  
      if (title) title.textContent = p.name;
      if (sub) sub.textContent = `${p.brand} · ${p.category || "General"}`;
  
      if (timeline) {
        const elapsed = w.left < 0 ? 1 : 1 - w.fraction;
        const pct = Math.round(elapsed * 100);
        timeline.innerHTML = `
          <div style="margin: 16px 0 8px;">
            <div style="height: 8px; border-radius: 999px; background: rgba(255,255,255,0.08); position: relative; overflow: hidden;">
              <div style="height: 100%; border-radius: 999px; background: ${w.colour}; width: ${pct}%;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.75rem; color: var(--text-dim);">
              <span>Purchased ${prettyDate(p.purchaseDate || p.purchase_date)}</span>
              <span>Expires ${prettyDate(w.expiry)}</span>
            </div>
            <p style="font-weight: 700; color: ${w.colour}; margin-top: 6px; font-size: 0.88rem;">
              ${w.left < 0 ? `Warranty expired ${-w.left} days ago` : w.left === 0 ? "Warranty expires today" : `${w.left} days remaining`}
            </p>
          </div>
        `;
      }
  
      if (specs) {
        specs.innerHTML = `
          <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; font-size: 0.88rem;">
            <dt style="color: var(--text-dim);">Purchase Price:</dt><dd>${rupees(p.purchasePrice || p.purchase_price || p.price)}</dd>
            <dt style="color: var(--text-dim);">Warranty Duration:</dt><dd>${p.warrantyMonths || p.warranty_months} months</dd>
            <dt style="color: var(--text-dim);">Model Number:</dt><dd>${p.modelNumber || p.model_number || "Not specified"}</dd>
            <dt style="color: var(--text-dim);">Serial Number:</dt><dd>${p.serialNumber || p.serial_number || "Not specified"}</dd>
            <dt style="color: var(--text-dim);">Product ID:</dt><dd style="font-family: var(--font-mono);">${p.id}</dd>
          </dl>
        `;
      }
  
      if (actions) {
        const tag = `my ${p.name} (product ID ${p.id})`;
        const shortcuts = [
          { label: "Check Warranty Status", cmd: `Check the warranty for ${tag}.` },
          { label: "What Maintenance is Due?", cmd: `What maintenance is due for ${tag}?` },
          { label: "Repair or Replace Advice", cmd: `Should I repair or replace ${tag}?` },
          { label: "Official Support Link", cmd: `Get official manufacturer support for ${tag}.` },
          { label: "Troubleshoot Problem", fill: `${p.name} (product ${p.id}) has a problem: ` },
          { label: "Draft Warranty Claim", fill: `Draft a warranty claim for ${tag}. The issue is: ` },
          { label: "Book Service Slot", fill: `Show available service slots for ${tag} on ` }
        ];
  
        actions.innerHTML = "";
        shortcuts.forEach((act) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "card-action-btn";
          btn.textContent = act.label;
          btn.onclick = () => {
            drawer.close();
            switchTab("copilot");
            if (act.cmd) {
              sendCopilotMessage(act.cmd);
            } else {
              fillCopilotInput(act.fill);
            }
          };
          actions.appendChild(btn);
        });
      }
  
      drawer.showModal();
    }
  
    const drawerCloseBtn = $("product-drawer-close-btn");
    if (drawerCloseBtn) {
      drawerCloseBtn.onclick = () => $("product-detail-drawer").close();
    }
  
    // ---------------------------------------------------------------------------
    // Add Product Modal & Invoice Upload
    // ---------------------------------------------------------------------------
    function openAddProductModal() {
      const dlg = $("add-product-dialog");
      if (!dlg) return;
      const form = $("add-product-form");
      if (form) form.reset();
      const dateInput = $("product-form-date");
      if (dateInput) dateInput.max = todayISO();
      dlg.showModal();
    }
  
    const addProductTrigger = $("top-add-product-btn");
    if (addProductTrigger) {
      addProductTrigger.onclick = openAddProductModal;
    }
  
    const addCloseBtn = $("add-product-close-btn");
    if (addCloseBtn) {
      addCloseBtn.onclick = () => $("add-product-dialog").close();
    }
  
    const addForm = $("add-product-form");
    if (addForm) {
      addForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(addForm);
        const name = fd.get("name")?.toString().trim();
        const brand = fd.get("brand")?.toString().trim();
        const category = fd.get("category")?.toString();
        const date = fd.get("date")?.toString();
        const price = fd.get("price")?.toString();
        const months = fd.get("months")?.toString();
        const model = fd.get("model")?.toString().trim();
        const serial = fd.get("serial")?.toString().trim();
  
        let text = `Add a product: ${name}, brand ${brand}, category ${category}, bought on ${date}, price ${price} rupees, warranty ${months} months`;
        if (model) text += `, model number ${model}`;
        if (serial) text += `, serial number ${serial}`;
  
        $("add-product-dialog").close();
        switchTab("copilot");
        sendCopilotMessage(text);
        showToast("Sent to Copilot. Please approve the review card to register.");
      });
    }
  
    // Invoice drag-and-drop simulated extraction
    const dropZone = $("invoice-drop-zone");
    const fileInput = $("invoice-file-input");
    if (dropZone && fileInput) {
      dropZone.addEventListener("click", () => fileInput.click());
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length) handleInvoiceFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener("change", () => {
        if (fileInput.files.length) handleInvoiceFile(fileInput.files[0]);
      });
    }
  
    function handleInvoiceFile(file) {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        showToast("Invoice file must be under 5MB", "warn");
        return;
      }
  
      const preview = $("invoice-preview-area");
      if (preview) {
        preview.innerHTML = `
          <div style="padding: 12px; border-radius: 8px; background: rgba(0,240,255,0.06); border: 1px solid var(--border-glow); margin-top: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <strong>${file.name}</strong> (${(file.size / 1024).toFixed(1)} KB)
            </div>
            <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">Simulated invoice scan: Detecting purchase details...</p>
          </div>
        `;
      }
  
      // Prefill form after brief scanning simulation
      setTimeout(() => {
        const f = $("add-product-form");
        if (f) {
          if (!f.elements.name.value) f.elements.name.value = "Samsung 4K Crystal UHD TV";
          if (!f.elements.brand.value) f.elements.brand.value = "Samsung";
          if (!f.elements.price.value) f.elements.price.value = "42990";
          if (!f.elements.months.value) f.elements.months.value = "24";
          if (!f.elements.date.value) f.elements.date.value = todayISO();
          showToast("Invoice scanned! Product details prefilled for review.");
        }
      }, 1200);
    }
  
    // ---------------------------------------------------------------------------
    // View 3: AI Care Copilot (Conversational + Safety Approval Workflow)
    // ---------------------------------------------------------------------------
    function updateCopilotProductContextList() {
      const sel = $("copilot-product-context-select");
      if (!sel) return;
  
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">All Household Products</option>';
  
      state.products.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.brand})`;
        sel.appendChild(opt);
      });
  
      if (currentVal) sel.value = currentVal;
    }
  
    function updateCopilotContextUI() {
      updateCopilotProductContextList();
    }
  
    const contextSel = $("copilot-product-context-select");
    if (contextSel) {
      contextSel.addEventListener("change", (e) => {
        const pid = e.target.value;
        state.selectedProductContext = pid ? state.products.find((p) => String(p.id) === String(pid)) : null;
        if (state.selectedProductContext) {
          showToast(`AI Copilot focused on: ${state.selectedProductContext.name}`);
        }
      });
    }
  
    // Quick Prompt Chips in Copilot
    $$(".prompt-chip-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        let promptText = btn.dataset.prompt || btn.textContent.trim();
        if (state.selectedProductContext) {
          promptText = `${promptText} for my ${state.selectedProductContext.name} (product ID ${state.selectedProductContext.id})`;
        }
        sendCopilotMessage(promptText);
      });
    });
  
    function fillCopilotInput(text) {
      const inp = $("chat-user-input");
      if (!inp) return;
      inp.value = text;
      inp.focus();
      inp.setSelectionRange(text.length, text.length);
    }
  
    function scrollChatToBottom() {
      const box = $("chat-messages-container");
      if (box) box.scrollTop = box.scrollHeight;
    }
  
    function appendChatMessage(role, text) {
      state.transcript.push({ role, text, at: new Date() });
      const container = $("chat-messages-container");
      if (!container) return;
  
      const row = document.createElement("div");
      row.className = `chat-msg ${role}`;
  
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = text;
      row.appendChild(bubble);
  
      if (role === "assistant") {
        const actions = document.createElement("div");
        actions.className = "chat-bubble-actions";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(text);
            showToast("Copied message to clipboard");
          } catch {
            showToast("Failed to copy", "warn");
          }
        };
        actions.appendChild(copyBtn);
        row.appendChild(actions);
      }
  
      container.appendChild(row);
      scrollChatToBottom();
    }
  
    function showTypingIndicator() {
      const container = $("chat-messages-container");
      if (!container) return null;
      const row = document.createElement("div");
      row.className = "chat-msg assistant typing-row";
      row.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
      container.appendChild(row);
      scrollChatToBottom();
      return row;
    }
  
    function addApprovalSlipCard(action) {
      const container = $("chat-messages-container");
      if (!container) return;
  
      state.transcript.push({
        role: "assistant",
        text: `Approval Requested: ${action.name} (${JSON.stringify(action.details)})`,
        at: new Date()
      });
  
      const row = document.createElement("div");
      row.className = "chat-msg assistant";
  
      const slip = document.createElement("div");
      slip.className = "approval-card-slip";
  
      const actionReadable = action.name.replaceAll("_", " ");
      slip.innerHTML = `
        <div class="slip-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Approval Required</span>
        </div>
        <div class="slip-sub">Consequential Action: <strong>${actionReadable}</strong></div>
        <dl class="slip-details-list">
          ${Object.entries(action.details || {})
            .map(([k, v]) => `<dt>${k}:</dt><dd>${typeof v === "object" ? JSON.stringify(v) : v}</dd>`)
            .join("")}
        </dl>
        <div class="slip-buttons-row">
          <button type="button" class="slip-btn approve">Approve & Execute</button>
          <button type="button" class="slip-btn cancel">Cancel Action</button>
        </div>
      `;
  
      const approveBtn = slip.querySelector(".approve");
      const cancelBtn = slip.querySelector(".cancel");
  
      function handleChoice(decision) {
        approveBtn.disabled = true;
        cancelBtn.disabled = true;
        state.awaitingApproval = false;
        refreshOrb();
  
        const resultBadge = document.createElement("div");
        resultBadge.className = `slip-status-badge ${decision === "approve" ? "approved" : "cancelled"}`;
        resultBadge.textContent = decision === "approve" ? "Action Approved by User" : "Action Cancelled by User";
        slip.querySelector(".slip-buttons-row").replaceWith(resultBadge);
  
        state.transcript.push({
          role: "user",
          text: decision === "approve" ? "Approved the action." : "Cancelled the action.",
          at: new Date()
        });
  
        callChatApi({ approval: decision });
      }
  
      approveBtn.onclick = () => handleChoice("approve");
      cancelBtn.onclick = () => handleChoice("cancel");
  
      row.appendChild(slip);
      container.appendChild(row);
      scrollChatToBottom();
    }
  
    // Web Speech API Voice synthesis
    function speakResponse(text) {
      if (window.CareOrbitVoice && window.CareOrbitVoice.active) return;
      const speakCheckbox = $("voice-speak-aloud-checkbox");
      if (!text || !("speechSynthesis" in window) || (!speakCheckbox?.checked && !state.lastWasVoice)) {
        return;
      }
      window.speechSynthesis.cancel();
      const langSel = $("voice-lang-select");
      const utterance = new SpeechSynthesisUtterance(text);
      if (langSel) utterance.lang = langSel.value;
  
      utterance.onstart = () => {
        state.isSpeaking = true;
        refreshOrb();
        const stopBtn = $("stop-voice-speak-btn");
        if (stopBtn) stopBtn.style.display = "inline-flex";
      };
  
      utterance.onend = utterance.onerror = () => {
        state.isSpeaking = false;
        refreshOrb();
        const stopBtn = $("stop-voice-speak-btn");
        if (stopBtn) stopBtn.style.display = "none";
      };
  
      window.speechSynthesis.speak(utterance);
    }
  
    const stopVoiceBtn = $("stop-voice-speak-btn");
    if (stopVoiceBtn) {
      stopVoiceBtn.onclick = () => {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        state.isSpeaking = false;
        refreshOrb();
        stopVoiceBtn.style.display = "none";
      };
    }
  
    async function callChatApi(payload) {
      state.isChatBusy = true;
      refreshOrb();
      const typing = showTypingIndicator();
  
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, sessionId: state.sessionId })
        });
        const data = await res.json().catch(() => ({}));
  
        if (data.sessionId) {
          state.sessionId = data.sessionId;
          try {
            sessionStorage.setItem("careorbit_session", state.sessionId);
          } catch {}
        }
  
        if (typing) typing.remove();
        state.isChatBusy = false;
  
        const reply = data.reply || "Something went wrong. Please try again.";
        appendChatMessage("assistant", reply);
  
        if (data.approvalRequired && data.action) {
          state.awaitingApproval = true;
          addApprovalSlipCard(data.action);
        }
  
        document.dispatchEvent(new CustomEvent("careorbit:reply", { detail: { reply } }));
        speakResponse(reply);
  
        // If approved, refresh products and summary
        if (payload.approval === "approve") {
          loadProducts();
          loadCareSummary();
          loadServiceRequests();
        }
      } catch (err) {
        if (typing) typing.remove();
        state.isChatBusy = false;
        appendChatMessage("assistant", "Could not connect to the CareOrbit server. Please check your network connection.");
        document.dispatchEvent(new CustomEvent("careorbit:reply", { detail: { reply: "Could not connect to the server. Please try again." } }));
      } finally {
        refreshOrb();
        const inp = $("chat-user-input");
        if (inp && !state.awaitingApproval) inp.focus();
      }
    }
  
    function sendCopilotMessage(msg, isVoice = false) {
      const clean = msg?.trim();
      if (!clean) return;
      if (state.isChatBusy || state.awaitingApproval) {
        showToast(state.awaitingApproval ? "Please approve or cancel the pending action card first." : "CareOrbit is still responding...");
        return;
      }
  
      state.lastWasVoice = isVoice;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  
      appendChatMessage("user", clean);
      const inp = $("chat-user-input");
      if (inp) inp.value = "";
  
      callChatApi({ message: clean });
    }
  
    const chatForm = $("chat-composer-form");
    if (chatForm) {
      chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const inp = $("chat-user-input");
        if (inp) sendCopilotMessage(inp.value);
      });
    }
  
    // Voice Speech Recognition
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognizer = null;
    const micBtn = $("voice-mic-trigger");
  
    if (!Recognition) {
      if (micBtn) micBtn.style.display = "none";
    } else if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (recognizer) {
          recognizer.stop();
          return;
        }
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        const langSel = $("voice-lang-select");
  
        recognizer = new Recognition();
        recognizer.lang = langSel ? langSel.value : "en-IN";
        recognizer.interimResults = true;
  
        recognizer.onresult = (evt) => {
          const text = Array.from(evt.results).map((r) => r[0].transcript).join("");
          const inp = $("chat-user-input");
          if (inp) inp.value = text;
        };
  
        recognizer.onend = () => {
          recognizer = null;
          state.isRecording = false;
          micBtn.classList.remove("recording");
          refreshOrb();
          const inp = $("chat-user-input");
          if (inp && inp.value.trim()) {
            sendCopilotMessage(inp.value, true);
          }
        };
  
        recognizer.onerror = () => {
          recognizer = null;
          state.isRecording = false;
          micBtn.classList.remove("recording");
          refreshOrb();
        };
  
        state.isRecording = true;
        micBtn.classList.add("recording");
        refreshOrb();
        recognizer.start();
      });
    }
  
    // Copilot toolbar: New Chat, Export Transcript
    const newChatBtn = $("chat-new-session-btn");
    if (newChatBtn) {
      newChatBtn.onclick = () => {
        if (state.isChatBusy) return;
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        state.sessionId = null;
        try { sessionStorage.removeItem("careorbit_session"); } catch {}
        state.awaitingApproval = false;
        state.transcript = [];
        const container = $("chat-messages-container");
        if (container) {
          container.innerHTML = "";
          appendChatMessage("assistant", "Hello! I am CareOrbit AI, your after-sale product care assistant. I monitor warranty durations, troubleshoot faults, schedule authorized servicing, and manage maintenance schedules. How may I assist your household today?");
        }
        refreshOrb();
        showToast("Started fresh chat session");
      };
    }
  
    const exportChatBtn = $("chat-export-btn");
    if (exportChatBtn) {
      exportChatBtn.onclick = () => {
        if (!state.transcript.length) {
          showToast("Transcript is currently empty");
          return;
        }
        const lines = state.transcript.map(
          (t) => `[${new Date(t.at).toLocaleTimeString()}] ${t.role.toUpperCase()}: ${t.text}`
        );
        const blob = new Blob([lines.join("\n\n") + "\n"], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `careorbit-chat-${todayISO()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        showToast("Transcript downloaded");
      };
    }
  
    // ---------------------------------------------------------------------------
    // View 4: Warranty Center
    // ---------------------------------------------------------------------------
    function renderWarrantyCenter() {
      const list = state.products.map((p) => ({ p, w: warrantyOf(p) }));
      const active = list.filter((x) => !x.w.isExpired);
      const soon = list.filter((x) => x.w.isExpiringSoon);
      const expired = list.filter((x) => x.w.isExpired);
  
      const cActive = $("warranty-count-active");
      const cSoon = $("warranty-count-soon");
      const cExpired = $("warranty-count-expired");
  
      if (cActive) cActive.textContent = String(active.length);
      if (cSoon) cSoon.textContent = String(soon.length);
      if (cExpired) cExpired.textContent = String(expired.length);
  
      // Populate warranty estimator product dropdown
      const estSelect = $("warranty-estimator-product-select");
      if (estSelect) {
        estSelect.innerHTML = '<option value="">Select a Registered Product</option>';
        state.products.forEach((p) => {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = `${p.name} (${p.brand})`;
          estSelect.appendChild(opt);
        });
      }
  
      // Populate Warranty Breakdown Table
      const tableBody = $("warranty-breakdown-table-body");
      if (tableBody) {
        if (!list.length) {
          tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 24px;">No products registered yet.</td></tr>`;
          return;
        }
        tableBody.innerHTML = list
          .map(({ p, w }) => `
            <tr>
              <td><strong>${p.name}</strong><br><small style="color: var(--text-dim);">${p.brand}</small></td>
              <td>${prettyDate(p.purchaseDate || p.purchase_date)}</td>
              <td>${prettyDate(w.expiry)}</td>
              <td>
                <span class="status-badge ${w.isExpired ? "cancelled" : w.isExpiringSoon ? "progress" : "completed"}">
                  ${w.isExpired ? "Expired" : w.isExpiringSoon ? `${w.left}d left` : "Active"}
                </span>
              </td>
              <td>
                <button type="button" class="banner-btn" onclick="window.CareOrbit.openDrawerById(${p.id})">Details</button>
              </td>
            </tr>
          `)
          .join("");
      }
    }
  
    // Warranty Coverage Estimator Tool Form
    const estForm = $("warranty-estimator-form");
    if (estForm) {
      estForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const pid = $("warranty-estimator-product-select")?.value;
        const issue = $("warranty-estimator-issue-input")?.value?.trim();
        if (!pid || !issue) {
          showToast("Please choose a product and describe the problem", "warn");
          return;
        }
        const prod = state.products.find((p) => String(p.id) === String(pid));
        if (!prod) return;
  
        const resCard = $("warranty-estimator-result");
        if (resCard) {
          const w = warrantyOf(prod);
          let assessment = "Potentially Covered (Manufacturer Evaluation Required)";
          let note = "Standard defects in materials or workmanship during the active warranty period are generally covered.";
  
          if (w.isExpired) {
            assessment = "Likely Not Covered (Warranty Expired)";
            note = "The recorded warranty for this product has ended. Paid repair or out-of-warranty service options apply.";
          } else if (/screen|crack|physical|water|liquid|drop|broken/i.test(issue)) {
            assessment = "Likely Excluded (Physical / Accidental Damage)";
            note = "Standard manufacturer warranties explicitly exclude physical drops, liquid ingress, or cosmetic damage unless you have an extended accidental damage protection plan.";
          }
  
          resCard.classList.add("show");
          resCard.innerHTML = `
            <h4 style="color: #fff; margin-bottom: 6px;">Coverage Assessment: <span style="color: var(--cyan);">${assessment}</span></h4>
            <p style="font-size: 0.88rem; color: var(--text-muted);">${note}</p>
            <div style="margin-top: 12px; display: flex; gap: 8px;">
              <button type="button" class="banner-btn primary" onclick="window.CareOrbit.draftClaimFor(${prod.id}, '${issue.replace(/'/g, "\\'")}')">Draft Official Claim</button>
            </div>
          `;
        }
      });
    }
  
    // ---------------------------------------------------------------------------
    // View 5: Service Requests & Appointments
    // ---------------------------------------------------------------------------
    function renderServiceRequests() {
      const tbody = $("service-requests-table-body");
      if (!tbody) return;
  
      if (!state.serviceRequests.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--text-dim); padding: 32px;">
              No service requests have been submitted yet. Click "Create Service Request" or ask the AI Copilot.
            </td>
          </tr>
        `;
        return;
      }
  
      tbody.innerHTML = state.serviceRequests
        .map((sr) => {
          const statusClass = (sr.status || "open").toLowerCase().replace(" ", "-");
          return `
            <tr>
              <td style="font-family: var(--font-mono);">#${sr.id}</td>
              <td><strong>${sr.productName || "Product #" + sr.product_id}</strong></td>
              <td>${sr.description || sr.issue || "N/A"}</td>
              <td><span class="status-badge ${statusClass}">${sr.status}</span></td>
              <td>${prettyDate(sr.created_at || sr.createdAt)}</td>
            </tr>
          `;
        })
        .join("");
    }
  
    function renderAppointments(appointments) {
      const listEl = $("appointments-list-container");
      if (!listEl) return;
  
      if (!appointments.length) {
        listEl.innerHTML = `
          <div class="empty-state-card" style="padding: 32px;">
            <p style="color: var(--text-muted);">No upcoming service appointments booked.</p>
          </div>
        `;
        return;
      }
  
      listEl.innerHTML = appointments
        .map(
          (apt) => `
          <div class="stat-card" style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div>
                <strong style="color: #fff; font-size: 1rem;">${apt.productName || "Product Appointment"}</strong>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">Date: ${apt.date} at ${apt.time}</p>
                <p style="font-size: 0.8rem; color: var(--text-dim); margin-top: 2px;">Status: ${apt.status || "Booked"}</p>
              </div>
              <span class="status-badge completed">Confirmed</span>
            </div>
          </div>
        `
        )
        .join("");
    }
  
    // Appointment slot check
    const slotDateInput = $("appointment-check-date");
    const slotProdSelect = $("appointment-check-product");
    if (slotDateInput) slotDateInput.min = todayISO();
  
    const slotCheckBtn = $("check-available-slots-btn");
    if (slotCheckBtn) {
      slotCheckBtn.addEventListener("click", async () => {
        const pid = slotProdSelect?.value;
        const date = slotDateInput?.value;
        if (!pid || !date) {
          showToast("Please choose product and future date", "warn");
          return;
        }
        const grid = $("available-slots-grid");
        if (grid) grid.innerHTML = "<p style='color: var(--text-dim);'>Checking demo calendar availability...</p>";
  
        try {
          const res = await fetch(`/api/slots?productId=${pid}&date=${date}`);
          const data = await res.json();
          const slots = data.slots || [];
          if (!slots.length) {
            if (grid) grid.innerHTML = "<p style='color: var(--warn);'>All simulated slots booked for this date.</p>";
            return;
          }
          if (grid) {
            grid.innerHTML = slots
              .map(
                (s) => `
              <button type="button" class="slot-btn" onclick="window.CareOrbit.bookSlot(${pid}, '${date}', '${s.time}')">${s.time}</button>
            `
              )
              .join("");
          }
        } catch {
          if (grid) grid.innerHTML = "<p style='color: var(--danger);'>Could not load slots.</p>";
        }
      });
    }
  
    // ---------------------------------------------------------------------------
    // View 6: Maintenance & View 7: History
    // ---------------------------------------------------------------------------
    function renderMaintenance() {
      const listEl = $("maintenance-tasks-container");
      if (!listEl) return;
  
      if (!state.maintenanceTasks.length) {
        listEl.innerHTML = `
          <div class="empty-state-card" style="padding: 32px;">
            <p style="color: var(--text-muted);">No upcoming maintenance tasks due. Your appliances are in top shape!</p>
          </div>
        `;
        return;
      }
  
      listEl.innerHTML = state.maintenanceTasks
        .map((t) => {
          const isOverdue = t.daysUntilDue < 0;
          return `
            <div class="stat-card ${isOverdue ? "stat-danger" : "stat-warn"}" style="margin-bottom: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <strong style="color: #fff; font-size: 0.95rem;">${t.task}</strong>
                  <small style="color: ${isOverdue ? 'var(--danger)' : 'var(--warn)'}; font-weight: 700;">
                    ${isOverdue ? `Overdue by ${-t.daysUntilDue} days` : `Due in ${t.daysUntilDue} days (${t.nextDueDate})`}
                  </small>
                </div>
                <button type="button" class="banner-btn primary" onclick="window.CareOrbit.completeTask(${t.id})">Mark Done</button>
              </div>
            </div>
          `;
        })
        .join("");
    }
  
    function renderServiceHistory() {
      const tbody = $("service-history-table-body");
      if (!tbody) return;
  
      if (!state.serviceHistory.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: 32px;">No historical events recorded yet.</td></tr>`;
        return;
      }
  
      tbody.innerHTML = state.serviceHistory
        .map(
          (h) => `
          <tr>
            <td>${prettyDate(h.event_date || h.created_at)}</td>
            <td><strong>${h.productName || "Product #" + h.product_id}</strong></td>
            <td><span class="status-badge open">${h.history_type || "Event"}</span></td>
            <td>${h.notes || "Recorded action"}</td>
          </tr>
        `
        )
        .join("");
    }
  
    // ---------------------------------------------------------------------------
    // Notifications & Command Palette
    // ---------------------------------------------------------------------------
    function updateNotificationBadge() {
      const badge = $("header-notification-badge");
      const countEl = $("notification-drawer-count");
      const urgentCount = state.products.map(warrantyOf).filter((w) => w.isExpiringSoon).length;
  
      if (badge) badge.style.display = urgentCount > 0 ? "block" : "none";
      if (countEl) countEl.textContent = `${urgentCount} urgent alert${urgentCount === 1 ? "" : "s"}`;
    }
  
    const notifBtn = $("header-notification-btn");
    const notifDrawer = $("notifications-drawer");
    if (notifBtn && notifDrawer) {
      notifBtn.onclick = () => {
        renderNotificationDrawer();
        notifDrawer.showModal();
      };
    }
  
    const notifClose = $("notifications-close-btn");
    if (notifClose && notifDrawer) {
      notifClose.onclick = () => notifDrawer.close();
    }
  
    function renderNotificationDrawer() {
      const container = $("notifications-list");
      if (!container) return;
  
      const urgent = state.products.map((p) => ({ p, w: warrantyOf(p) })).filter((x) => x.w.isExpiringSoon);
  
      if (!urgent.length) {
        container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 20px;">All warranties and tasks are in order.</p>`;
        return;
      }
  
      container.innerHTML = urgent
        .map(
          ({ p, w }) => `
          <div class="timeline-item">
            <div class="timeline-dot" style="background: var(--warn);"></div>
            <div class="timeline-content">
              <div class="timeline-title">${p.name} Warranty Ending</div>
              <div class="timeline-sub">Ends in ${w.left} days (${prettyDate(w.expiry)})</div>
            </div>
          </div>
        `
        )
        .join("");
    }
  
    // Command Palette [Ctrl+K]
    const cmdDlg = $("cmd-palette-dialog");
    const cmdInput = $("cmd-palette-input");
    const cmdList = $("cmd-palette-results");
  
    function openCommandPalette() {
      if (!cmdDlg) return;
      if (cmdInput) cmdInput.value = "";
      filterCommands("");
      cmdDlg.showModal();
      if (cmdInput) cmdInput.focus();
    }
  
    const cmdTrigger = $("header-search-trigger");
    if (cmdTrigger) cmdTrigger.onclick = openCommandPalette;
  
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCommandPalette();
      } else if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        e.preventDefault();
        openCommandPalette();
      }
    });
  
    const COMMANDS = [
      { title: "Go to Overview Dashboard", icon: "grid", action: () => switchTab("overview") },
      { title: "Manage My Products", icon: "box", action: () => switchTab("products") },
      { title: "Open AI Care Copilot", icon: "message-square", action: () => switchTab("copilot") },
      { title: "Check Warranty Center", icon: "shield", action: () => switchTab("warranty") },
      { title: "View Service Requests", icon: "tool", action: () => switchTab("services") },
      { title: "Register a New Product", icon: "plus-circle", action: () => openAddProductModal() },
      { title: "Switch Theme (Light / Dark)", icon: "sun", action: () => applyTheme(state.theme === "light" ? "dark" : "light") },
      { title: "Replay Cinematic 3D Intro", icon: "play", action: () => window.replayIntro && window.replayIntro() }
    ];
  
    function filterCommands(q) {
      if (!cmdList) return;
      const clean = q.trim().toLowerCase();
      const matchedCmds = COMMANDS.filter((c) => !clean || c.title.toLowerCase().includes(clean));
      const matchedProducts = state.products.filter((p) => clean && `${p.name} ${p.brand}`.toLowerCase().includes(clean));
  
      let html = "";
      matchedCmds.forEach((c) => {
        html += `<div class="cmd-item" data-type="cmd" data-title="${c.title}">${c.title}</div>`;
      });
      if (matchedProducts.length) {
        html += `<div style="font-size: 0.72rem; color: var(--text-dim); padding: 8px 12px; text-transform: uppercase;">Products</div>`;
        matchedProducts.forEach((p) => {
          html += `<div class="cmd-item" data-type="product" data-id="${p.id}">Inspect: ${p.name} (${p.brand})</div>`;
        });
      }
  
      cmdList.innerHTML = html;
      cmdList.querySelectorAll(".cmd-item").forEach((item) => {
        item.onclick = () => {
          cmdDlg.close();
          if (item.dataset.type === "cmd") {
            const match = COMMANDS.find((c) => c.title === item.dataset.title);
            if (match) match.action();
          } else if (item.dataset.type === "product") {
            const prod = state.products.find((p) => String(p.id) === item.dataset.id);
            if (prod) openProductDrawer(prod);
          }
        };
      });
    }
  
    if (cmdInput) {
      cmdInput.addEventListener("input", (e) => filterCommands(e.target.value));
    }
  
    // ---------------------------------------------------------------------------
    // Public Global Helpers for Inline Callbacks
    // ---------------------------------------------------------------------------
    window.CareOrbit = {
      sendMessage(text) {
        sendCopilotMessage(text, false);
      },
      isBusy() {
        return state.isChatBusy || state.awaitingApproval;
      },
      openTab(tabId) {
        switchTab(tabId);
      },
      openDrawerById(id) {
        const prod = state.products.find((p) => String(p.id) === String(id));
        if (prod) openProductDrawer(prod);
      },
      draftClaimFor(id, issue) {
        const prod = state.products.find((p) => String(p.id) === String(id));
        if (!prod) return;
        switchTab("copilot");
        sendCopilotMessage(`Draft a warranty claim for my ${prod.name} (product ID ${prod.id}). The issue is: ${issue}`);
      },
      bookSlot(id, date, time) {
        const prod = state.products.find((p) => String(p.id) === String(id));
        if (!prod) return;
        switchTab("copilot");
        sendCopilotMessage(`Book a service appointment slot for my ${prod.name} (product ID ${prod.id}) on ${date} at ${time}. Issue: General maintenance checkup.`);
        showToast("Booking request sent to Copilot. Please approve the review card to confirm.");
      },
      completeTask(taskId) {
        switchTab("copilot");
        sendCopilotMessage(`Record maintenance task #${taskId} as completed today.`);
        showToast("Sent to Copilot. Please approve to reset due date.");
      }
    };
  
    // ---------------------------------------------------------------------------
    // Initial Boot
    // ---------------------------------------------------------------------------
    function init() {
      applyTheme(state.theme);
      checkSystemHealth();
      loadProducts();
      loadCareSummary();
      loadServiceRequests();
      loadMaintenance();
  
      appendChatMessage(
        "assistant",
        "Hello! I am CareOrbit AI, your after-sale product care assistant. I monitor warranty durations, troubleshoot faults, schedule authorized servicing, and manage maintenance schedules. How may I assist your household today?"
      );
  
      // Periodic background sync every 30s
      setInterval(() => {
        checkSystemHealth();
      }, 30000);
    }
  
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();
  