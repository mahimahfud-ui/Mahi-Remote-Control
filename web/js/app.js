(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const pair = $("#pair");
  const app = $("#app");
  const status = $("#pair-status");
  const inputs = $$(".code input");
  const connectBtn = $("#connect");
  const durEl = $("#dur");
  const drawer = $("#drawer");
  const drawerTitle = $("#drawer-title");
  const drawerBody = $("#drawer-body");
  const modal = $("#modal");
  const toast = $("#toast");

  const titles = { files: "Files", apps: "Apps", diag: "Diagnostics", settings: "Settings" };

  // Pairing inputs
  inputs.forEach((inp, i) => {
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/\D/g, "").slice(0, 1);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !inp.value && i > 0) inputs[i - 1].focus();
      if (e.key === "Enter") connectBtn.click();
    });
    inp.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      t.split("").forEach((c, j) => { if (inputs[j]) inputs[j].value = c; });
      if (t.length) inputs[Math.min(t.length, 5)].focus();
    });
  });

  function code() {
    return inputs.map((i) => i.value).join("");
  }

  // Demo pair (replace with real signalling)
  async function pairDevice(c) {
    status.textContent = "Connecting…";
    status.classList.remove("error");
    await new Promise((r) => setTimeout(r, 700));
    if (c === "000000") {
      status.textContent = "Invalid or expired code. Try again.";
      status.classList.add("error");
      return false;
    }
    return true;
  }

  connectBtn.addEventListener("click", async () => {
    const c = code();
    if (c.length !== 6) {
      status.textContent = "Enter all 6 digits.";
      status.classList.add("error");
      return;
    }
    connectBtn.disabled = true;
    const ok = await pairDevice(c);
    connectBtn.disabled = false;
    if (ok) {
      pair.hidden = true;
      app.hidden = false;
      startTimer();
      showToast("Connected securely");
    }
  });

  // Session timer
  let t0 = 0, timer;
  function startTimer() {
    t0 = Date.now();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const h = String(Math.floor(s / 3600)).padStart(2, "0");
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const sec = String(s % 60).padStart(2, "0");
      durEl.textContent = `${h}:${m}:${sec}`;
    }, 1000);
  }

  // Dock / drawer
  $$(".dock-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.panel;
      $$(".dock-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (!p || p === "null") {
        drawer.hidden = true;
        return;
      }
      drawer.hidden = false;
      drawerTitle.textContent = titles[p] || p;
      $$(".panel", drawerBody).forEach((el) => {
        el.hidden = el.dataset.panel !== p;
      });
    });
  });

  $("[data-close]")?.addEventListener("click", () => {
    drawer.hidden = true;
    $$(".dock-btn").forEach((b) => b.classList.toggle("active", b.dataset.panel === "null"));
  });

  // Stop session
  function openStop() { modal.hidden = false; }
  function closeStop() { modal.hidden = true; }

  $$("[data-stop]").forEach((b) => b.addEventListener("click", openStop));
  $("#cancel")?.addEventListener("click", closeStop);
  $("#confirm")?.addEventListener("click", () => {
    closeStop();
    clearInterval(timer);
    app.hidden = true;
    pair.hidden = false;
    inputs.forEach((i) => (i.value = ""));
    status.textContent = "";
    inputs[0].focus();
    showToast("Session ended");
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      if (!app.hidden) openStop();
    }
  });

  // Preview states (design helper)
  $("#state-select")?.addEventListener("change", (e) => {
    const v = e.target.value;
    ["live", "loading", "error", "empty"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== v;
    });
  });

  $("[data-reconnect]")?.addEventListener("click", () => {
    document.getElementById("error").hidden = true;
    document.getElementById("loading").hidden = false;
    setTimeout(() => {
      document.getElementById("loading").hidden = true;
      document.getElementById("live").hidden = false;
      showToast("Reconnected");
    }, 1200);
  });

  // Touch / click on screen (hook for data channel)
  $("#screen")?.addEventListener("pointerdown", (e) => {
    // Integration point: send tap/drag to device via WebRTC data channel
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width).toFixed(3);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(3);
    console.debug("pointer", x, y);
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  }
})();
