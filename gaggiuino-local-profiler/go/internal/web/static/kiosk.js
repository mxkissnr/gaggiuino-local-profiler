(function () {
  "use strict";

  // ── Token bootstrap (mirrors static/glp-token.js's fetch-and-attach
  // pattern for this page's own fetch() calls instead of htmx) ──────────
  // All "../api/..." paths (not "api/..."): this page is served from
  // /ui/kiosk, one segment below where its own web/static/kiosk.js lives
  // (/ui/web/static/, which is why THAT reference stays a plain relative
  // "web/static/kiosk.js"), but /api/* is mounted only at the app root,
  // not mirrored under /ui/ — a plain relative "api/..." from here would
  // resolve to the nonexistent /ui/api/... instead. "../api/..." climbs
  // back to root first, which still resolves correctly through an HA
  // Ingress prefix (the ".." only removes this page's own "ui/kiosk"
  // segment, not the prefix in front of it).
  var token = null;
  var tokenPromise = fetch("../api/token")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) { if (body && body.apiToken) token = body.apiToken; })
    .catch(function () {});

  function api(path, opts) {
    opts = opts || {};
    return tokenPromise.then(function () {
      var headers = Object.assign({}, opts.headers || {});
      if (token) headers["X-GLP-Token"] = token;
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    });
  }

  // ── State ───────────────────────────────────────────────────────────
  var guestName = "";
  var selectedDrink = null; // {id, name, emoji, variants}
  var selectedVariants = []; // string[]
  var menu = [];
  var resetTimer = null;

  var variantRow = document.getElementById("variantRow");
  var nameStep = document.getElementById("nameStep");
  var menuStep = document.getElementById("menuStep");
  var thanksStep = document.getElementById("thanksStep");
  var closedBanner = document.getElementById("closedBanner");
  var nameInput = document.getElementById("nameInput");
  var nameNext = document.getElementById("nameNext");
  var greetName = document.getElementById("greetName");
  var changeName = document.getElementById("changeName");
  var drinkGrid = document.getElementById("drinkGrid");
  var noteInput = document.getElementById("noteInput");
  var placeOrderBtn = document.getElementById("placeOrder");
  var orderError = document.getElementById("orderError");
  var thanksName = document.getElementById("thanksName");
  var thanksEta = document.getElementById("thanksEta");
  var queueList = document.getElementById("queueList");
  var queueEmpty = document.getElementById("queueEmpty");

  function showStep(step) {
    [nameStep, menuStep, thanksStep].forEach(function (s) { s.classList.remove("active"); });
    step.classList.add("active");
  }

  // ── Name step ───────────────────────────────────────────────────────
  nameInput.addEventListener("input", function () {
    nameNext.classList.toggle("ready", nameInput.value.trim().length > 0);
  });
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && nameInput.value.trim()) goToMenu();
  });
  nameNext.addEventListener("click", function () {
    if (nameInput.value.trim()) goToMenu();
  });
  changeName.addEventListener("click", function () {
    guestName = "";
    nameInput.value = "";
    nameNext.classList.remove("ready");
    selectedDrink = null;
    selectedVariants = [];
    renderDrinkSelection();
    showStep(nameStep);
    setTimeout(function () { nameInput.focus(); }, 50);
  });

  function goToMenu() {
    guestName = nameInput.value.trim().slice(0, 50);
    greetName.textContent = guestName;
    showStep(menuStep);
  }

  // ── Menu step ───────────────────────────────────────────────────────
  function renderMenu() {
    drinkGrid.innerHTML = "";
    menu.forEach(function (item) {
      var btn = document.createElement("button");
      btn.className = "drink";
      btn.dataset.id = item.id;
      btn.innerHTML =
        '<span class="emoji">' + escapeHtml(item.emoji || "☕") + "</span><span>" + escapeHtml(item.name) + "</span>";
      btn.addEventListener("click", function () {
        selectedDrink = item;
        selectedVariants = [];
        renderDrinkSelection();
      });
      drinkGrid.appendChild(btn);
    });
  }
  function renderDrinkSelection() {
    Array.prototype.forEach.call(drinkGrid.children, function (el) {
      el.classList.toggle("selected", selectedDrink && el.dataset.id === selectedDrink.id);
    });
    renderVariants();
    placeOrderBtn.classList.toggle("ready", !!selectedDrink);
  }

  function renderVariants() {
    // remove all chips (keep the label at index 0)
    while (variantRow.children.length > 1) variantRow.removeChild(variantRow.lastChild);
    var variants = selectedDrink && selectedDrink.variants;
    if (!variants || !variants.length) {
      variantRow.classList.remove("visible");
      selectedVariants = [];
      return;
    }
    variantRow.classList.add("visible");
    variants.forEach(function (v) {
      var btn = document.createElement("button");
      btn.className = "variant-chip" + (selectedVariants.indexOf(v) !== -1 ? " selected" : "");
      btn.textContent = v;
      btn.addEventListener("click", function () {
        var idx = selectedVariants.indexOf(v);
        if (idx === -1) selectedVariants.push(v);
        else selectedVariants.splice(idx, 1);
        renderVariants();
      });
      variantRow.appendChild(btn);
    });
  }

  placeOrderBtn.addEventListener("click", function () {
    if (!selectedDrink) return;
    placeOrderBtn.classList.remove("ready");
    orderError.textContent = "";
    api("../api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: selectedDrink.name, customer: guestName, note: noteInput.value.trim(), variants: selectedVariants.length ? selectedVariants : undefined }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; }); })
      .then(function (res) {
        if (!res.ok) {
          orderError.textContent = res.status === 429
            ? "Kurz warten, dann nochmal versuchen."
            : (res.body && res.body.error) || "Bestellung fehlgeschlagen.";
          renderDrinkSelection();
          return;
        }
        onOrderPlaced(res.body);
      })
      .catch(function () {
        orderError.textContent = "Verbindung fehlgeschlagen.";
        renderDrinkSelection();
      });
  });

  function onOrderPlaced(order) {
    thanksName.textContent = guestName;
    thanksEta.textContent = "";
    showStep(thanksStep);
    noteInput.value = "";
    selectedDrink = null;

    // Best-effort ETA lookup — the confirmation shows regardless if this fails.
    api("../api/orders/queue-eta").then(function (r) { return r.ok ? r.json() : null; }).then(function (eta) {
      var pos = eta && eta.positions && order && order.id ? eta.positions[order.id] : null;
      thanksEta.textContent = pos ? "Fertig in ca. " + pos.suggestedEta + " Min" : "";
    }).catch(function () {});

    refreshQueue();

    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      guestName = "";
      nameInput.value = "";
      nameNext.classList.remove("ready");
      selectedDrink = null;
      selectedVariants = [];
      renderDrinkSelection();
      showStep(nameStep);
    }, 6000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── Queue panel ─────────────────────────────────────────────────────
  var STATUS_LABEL = { pending: "wartet", accepted: "wird zubereitet" };

  function refreshQueue() {
    Promise.all([
      api("../api/orders").then(function (r) { return r.ok ? r.json() : []; }),
      api("../api/orders/queue-eta").then(function (r) { return r.ok ? r.json() : null; }),
    ])
      .then(function (res) {
        var orders = res[0] || [];
        var eta = res[1];
        var active = orders.filter(function (o) { return o.status === "pending" || o.status === "accepted"; });
        renderQueue(active, eta);
      })
      .catch(function () {});
  }

  function renderQueue(active, eta) {
    queueList.innerHTML = "";
    queueEmpty.style.display = active.length ? "none" : "block";
    active.forEach(function (o) {
      var item = menu.find(function (m) { return m.name === o.item; });
      var row = document.createElement("div");
      row.className = "qitem" + (o.status === "accepted" ? " accepted" : "");
      var etaText = "";
      if (o.status === "accepted" && o.acceptedAt && o.eta) {
        var remaining = Math.ceil((o.acceptedAt + o.eta * 60000 - Date.now()) / 60000);
        etaText = remaining > 0 ? "~" + remaining + " Min" : "gleich fertig";
      } else if (eta && eta.positions && eta.positions[o.id]) {
        etaText = "~" + eta.positions[o.id].suggestedEta + " Min";
      }
      row.innerHTML =
        '<span class="qemoji">' + escapeHtml(item && item.emoji ? item.emoji : "☕") + '</span>' +
        '<span class="qmeta"><div class="qname">' + escapeHtml(o.customer || "?") + '</div>' +
        '<div class="qitemname">' + escapeHtml(o.item) + " · " + escapeHtml(STATUS_LABEL[o.status] || o.status) + "</div></span>" +
        '<span class="qeta">' + escapeHtml(etaText) + "</span>";
      queueList.appendChild(row);
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────
  function checkOpenAndLoadMenu() {
    api("../api/orders/settings")
      .then(function (r) {
        if (r.status === 404) throw new Error("feature-disabled");
        return r.json();
      })
      .then(function (settings) {
        closedBanner.style.display = settings && settings.enabled === false ? "block" : "none";
        return api("../api/menu");
      })
      .then(function (r) { return r.json(); })
      .then(function (items) {
        menu = items || [];
        if (!menuStep.classList.contains("active")) renderMenu();
      })
      .catch(function (err) {
        closedBanner.textContent = err && err.message === "feature-disabled"
          ? "Bestellungen sind auf diesem System nicht aktiviert."
          : "Verbindung zum Server fehlgeschlagen.";
        closedBanner.style.display = "block";
      });
  }

  checkOpenAndLoadMenu();
  refreshQueue();
  setInterval(refreshQueue, 8000);
  setInterval(checkOpenAndLoadMenu, 30000);
  setTimeout(function () { nameInput.focus(); }, 100);
})();
