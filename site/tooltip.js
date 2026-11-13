(() => {
  const tt = document.getElementById("tt");
  const KEYS = { "List of dicts": "--s2", "Array of objects / list of dicts": "--s2", Original: "--s2", packmem: "--s1", "One line changed": "--s1" };
  function show(data, x, y) {
    tt.replaceChildren();
    if (data.title) {
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = data.title;
      tt.append(t);
    }
    for (const [name, value] of data.rows) {
      const r = document.createElement("div");
      r.className = "r";
      const n = document.createElement("span");
      if (name && KEYS[name]) {
        const k = document.createElement("i");
        k.style.background = `var(${KEYS[name]})`;
        n.append(k);
      }
      n.append(document.createTextNode(name));
      const v = document.createElement("b");
      v.textContent = value;
      r.append(n, v);
      tt.append(r);
    }
    tt.hidden = false;
    const w = tt.offsetWidth, h = tt.offsetHeight;
    tt.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
    tt.style.top = `${Math.max(8, y - h - 12)}px`;
  }
  const hide = () => (tt.hidden = true);

  for (const el of document.querySelectorAll("[data-tip]")) {
    const data = JSON.parse(el.dataset.tip);
    el.addEventListener("pointermove", (e) => show(data, e.clientX, e.clientY));
    el.addEventListener("pointerleave", hide);
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      show(data, r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", hide);
  }

  const fmt = (v) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US")) + " MB";
  for (const chart of document.querySelectorAll(".lchart")) {
    const pts = JSON.parse(chart.dataset.points);
    const [aName, bName] = JSON.parse(chart.dataset.names);
    const area = chart.querySelector(".area");
    const xh = chart.querySelector(".xhair");
    let i = pts.length - 1;
    const render = (cx, cy) => {
      const p = pts[i];
      xh.hidden = false;
      xh.style.left = `${p.x}%`;
      show({ title: `${p.rows.toLocaleString("en-US")} rows`, rows: [[aName, fmt(p.a)], [bName, fmt(p.b)], ["", `${(p.a / p.b).toFixed(1)}× less`]] }, cx, cy);
    };
    area.addEventListener("pointermove", (e) => {
      const r = area.getBoundingClientRect();
      const pct = ((e.clientX - r.left) / r.width) * 100;
      i = pts.reduce((best, p, j) => (Math.abs(p.x - pct) < Math.abs(pts[best].x - pct) ? j : best), 0);
      render(e.clientX, e.clientY);
    });
    area.addEventListener("pointerleave", () => { xh.hidden = true; hide(); });
    chart.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      i = Math.max(0, Math.min(pts.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)));
      const r = area.getBoundingClientRect();
      render(r.left + (pts[i].x / 100) * r.width, r.top + 20);
      e.preventDefault();
    });
    chart.addEventListener("blur", () => { xh.hidden = true; hide(); });
  }
})();
