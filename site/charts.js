/* Chart helpers for the crawl dashboard. Line, stacked-column, histogram and sparkline charts are drawn with
   Plotly.js (loaded from a CDN in index.html). The ranked domain lists and the table views are plain HTML.
   Colors come from the CSS variables in style.css and are read at each render, so switching themes re-renders. */
"use strict";

const Charts = (() => {
  // ---- DOM helper -------------------------------------------------------------------------------------------------

  // Strings become text nodes, never markup, so names that come from W&B can't inject HTML.
  function html(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }

  // ---- Number formats ---------------------------------------------------------------------------------------------

  function trim(x, decimals) {
    const s = x.toFixed(decimals);
    return decimals > 0 ? s.replace(/\.?0+$/, "") : s;
  }

  function compact(v) {
    const a = Math.abs(v);
    for (const [n, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
      if (a >= n) return trim(v / n, a / n >= 100 ? 0 : 1) + suffix;
    }
    return trim(v, a >= 100 || Number.isInteger(v) ? 0 : a >= 10 ? 1 : 2);
  }

  const F = {
    count: (v) => (Math.abs(v) < 1e5 ? Math.round(v).toLocaleString("en-US") : compact(v)),
    int: (v) => Math.round(v).toLocaleString("en-US"),
    pct: (v) => trim(v, Math.abs(v) >= 10 ? 1 : Math.abs(v) >= 1 ? 2 : 3) + "%",
    score: (v) => v.toFixed(v !== 0 && Math.abs(v) < 0.01 ? 4 : 3),
    corr: (v) => v.toFixed(2),
    num: (v) => trim(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : Math.abs(v) >= 1 ? 2 : 4),
    ms: (v) => Math.round(v).toLocaleString("en-US") + " ms",
    mbps: (v) => trim(v, v >= 100 ? 0 : 1) + " MB/s",
    kbps: (v) => trim(v, v >= 100 ? 0 : 1) + " kbps",
    gb: (v) => trim(v, v >= 100 ? 0 : 1) + " GB",
    kb: (v) => trim(v, v >= 100 ? 0 : 1) + " KB",
    auto: (v) =>
      Math.abs(v) >= 1e5 ? compact(v) : Number.isInteger(v) ? v.toLocaleString("en-US") : String(+v.toPrecision(4)),
  };

  // Signed change between two values, in percentage points for percentages.
  function signed(d, unit) {
    const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
    const a = Math.abs(d);
    if (unit === "pct") return sign + trim(a, a >= 10 ? 1 : 2) + " pp";
    if (unit === "corr") return sign + a.toFixed(3); // correlations move in the third decimal between cycles
    return sign + F[unit](a);
  }

  // ---- Plotly plumbing --------------------------------------------------------------------------------------------

  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const CONFIG = {
    responsive: true,
    displaylogo: false,
    modeBarButtons: [["zoom2d", "pan2d", "resetScale2d", "toImage"]],
    toImageButtonOptions: { format: "png", scale: 2 },
  };
  const plotted = new Set(); // plots on the page; purged before each re-render

  function destroyAll() {
    if (window.Plotly) for (const el of plotted) Plotly.purge(el);
    plotted.clear();
  }

  function palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    return {
      surface: v("--surface"),
      ink: v("--ink"),
      ink2: v("--ink-2"),
      muted: v("--muted"),
      grid: v("--grid"),
      axis: v("--axis"),
      border: v("--border"),
      slot: (s) => v(s === "muted" ? "--muted" : "--s" + s),
    };
  }

  function alpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  const show = (fmt) => (v) => (v == null ? "—" : fmt(v));

  // Plotly fills its container, so each chart gets a fixed-height box that also holds the axes and legend.
  function plot(host, height, label, traces, layout, config) {
    host.textContent = "";
    if (!window.Plotly) {
      host.append(html("p", { class: "empty", text: "The chart library didn't load (no internet connection?). The Table button still works." }));
      return;
    }
    const box = html("div", label ? { class: "chart-box", role: "img", "aria-label": label } : { class: "chart-box", "aria-hidden": "true" });
    box.style.height = height + "px";
    host.append(box);
    plotted.add(box);
    Plotly.newPlot(box, traces, layout, { ...CONFIG, ...config }).catch((err) => failed(host, err));
  }

  // Shown in place of a chart that couldn't be drawn, with the browser's message so the cause can be traced.
  function failed(host, err) {
    console.error(err);
    host.textContent = "";
    host.append(html("p", { class: "empty", text: `This chart couldn't be drawn: ${(err && err.message) || err}` }));
  }

  function resize(host) {
    const box = host.querySelector(".chart-box");
    // Plotly rejects a resize of a chart that was removed in the meantime; nothing needs doing then.
    if (box && window.Plotly) Promise.resolve(Plotly.Plots.resize(box)).catch(() => {});
  }

  // Shared look: hairline gridlines, no vertical grid, muted ticks with the selected cycle in bold, and one hover
  // readout listing every series at the hovered cycle. Dragging doesn't zoom (it would fight page scrolling);
  // the zoom and pan buttons in the chart's corner menu turn it on.
  function baseLayout(p, o) {
    const xaxis = {
      showgrid: false,
      zeroline: false,
      showline: true,
      linecolor: p.axis,
      ticks: "",
      hoverformat: "d",
      title: { text: o.xTitle || "Cycle", font: { size: 11, color: p.muted }, standoff: 4 },
      automargin: true,
    };
    if (o.x && o.x.length <= 12) {
      xaxis.tickvals = o.x;
      xaxis.ticktext = o.x.map((c) => (c === o.selectedX ? `<b>${c}</b>` : String(c)));
    }
    const yaxis = {
      gridcolor: p.grid,
      zeroline: false,
      ticks: "",
      automargin: true,
      fixedrange: true,
      rangemode: o.zero === false ? "normal" : "tozero",
      ticksuffix: o.unit === "pct" ? "%" : "",
      nticks: 6,
    };
    if (o.unit === "count") {
      if (o.max < 10) yaxis.dtick = 1;
      yaxis.tickformat = o.max >= 1e4 ? "~s" : ",d";
    }
    return {
      autosize: true,
      margin: { l: 8, r: 12, t: o.legend ? 30 : 8, b: 8 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: FONT, size: 11, color: p.muted },
      showlegend: !!o.legend,
      legend: { orientation: "h", x: 0, xanchor: "left", y: 1, yanchor: "bottom", font: { size: 12, color: p.ink2 }, bgcolor: "rgba(0,0,0,0)" },
      hovermode: "x unified",
      hoverlabel: { bgcolor: p.surface, bordercolor: p.border, font: { family: FONT, size: 12, color: p.ink } },
      modebar: { bgcolor: "rgba(0,0,0,0)", color: p.muted, activecolor: p.ink },
      dragmode: false,
      xaxis,
      yaxis,
    };
  }

  const finite = (arrays) => arrays.flat().filter((v) => v != null);

  // ---- Line chart -------------------------------------------------------------------------------------------------
  // spec: { name, x, series: [{label, values, slot}], band?: {lo, hi, label, loLabel, hiLabel, slot},
  //         unit, fmt, zero, height, legend, selectedX }

  // A dot marks each series' latest value, and any point with no neighbours (it would be invisible otherwise).
  function dotSizes(values) {
    let last = values.length - 1;
    while (last >= 0 && values[last] == null) last--;
    return values.map((v, i) => {
      if (v == null) return 0;
      const alone = (i === 0 || values[i - 1] == null) && (i === values.length - 1 || values[i + 1] == null);
      return i === last || alone ? 8 : 0;
    });
  }

  // legendrank orders both the legend and the hover readout: the lines first, the band after them.
  function line(host, spec) {
    const p = palette();
    const fmt = show(spec.fmt);
    const traces = [];
    if (spec.band) {
      // The band's two edges are drawn first so the lines go over it; the upper edge fills down to the lower one.
      const wash = alpha(p.slot(spec.band.slot), 0.16);
      const edge = (values, hoverLabel, extra) => ({
        type: "scatter",
        mode: "lines",
        x: spec.x,
        y: values,
        line: { width: 0, color: wash },
        connectgaps: false,
        legendgroup: "band",
        customdata: values.map(fmt),
        hovertemplate: `%{customdata}  ${hoverLabel}<extra></extra>`,
        ...extra,
      });
      traces.push(edge(spec.band.lo, spec.band.loLabel, { name: spec.band.loLabel, showlegend: false, legendrank: 900 }));
      traces.push(edge(spec.band.hi, spec.band.hiLabel, { name: spec.band.label, fill: "tonexty", fillcolor: wash, legendrank: 901 }));
    }
    spec.series.forEach((s, k) => {
      const c = p.slot(s.slot);
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        name: s.label,
        legendrank: 100 + k,
        x: spec.x,
        y: s.values,
        connectgaps: false,
        line: { color: c, width: 2 },
        marker: { color: c, size: dotSizes(s.values), line: { color: p.surface, width: 2 } },
        customdata: s.values.map(fmt),
        hovertemplate: `%{customdata}  ${s.label}<extra></extra>`,
      });
    });
    const max = Math.max(...finite([...spec.series.map((s) => s.values), ...(spec.band ? [spec.band.hi] : [])]));
    plot(host, spec.height, spec.name, traces, baseLayout(p, { ...spec, max }));
  }

  // ---- Stacked columns --------------------------------------------------------------------------------------------
  // spec: { name, x, series: [{label, values, slot}] bottom to top, unit, fmt, height, legend, selectedX }

  function stack(host, spec) {
    const p = palette();
    const fmt = show(spec.fmt);
    // A 1px surface outline on every segment leaves a 2px gap between neighbours; the column top is rounded.
    // The legend and hover readout list segments top to bottom, as they're stacked, then the total.
    const n = spec.series.length;
    const traces = spec.series.map((s, k) => ({
      type: "bar",
      name: s.label,
      legendrank: 100 + (n - 1 - k),
      x: spec.x,
      y: s.values,
      marker: { color: p.slot(s.slot), line: { color: p.surface, width: 1 } },
      customdata: s.values.map(fmt),
      hovertemplate: `%{customdata}  ${s.label}<extra></extra>`,
    }));
    const totals = spec.x.map((_, i) => spec.series.reduce((t, s) => t + (s.values[i] > 0 ? s.values[i] : 0), 0));
    if (spec.series.length > 1) {
      // Invisible markers at each column's top, so the hover readout ends with the total.
      traces.push({
        type: "scatter",
        mode: "markers",
        name: "Total",
        legendrank: 999,
        x: spec.x,
        y: totals,
        showlegend: false,
        marker: { size: 1, opacity: 0 },
        customdata: totals.map(fmt),
        hovertemplate: "%{customdata}  Total<extra></extra>",
      });
    }
    const layout = baseLayout(p, { ...spec, zero: true, max: Math.max(...totals) });
    Object.assign(layout, { barmode: "stack", bargap: 0.5, barcornerradius: 4 });
    layout.legend.traceorder = "normal"; // Plotly reverses stacked legends by default; the ranks above set the order
    plot(host, spec.height, spec.name, traces, layout);
  }

  // ---- Histogram --------------------------------------------------------------------------------------------------
  // spec: { name, bins: [{lo, hi}], series: {label, values, slot}, ref?: {label, values, slot}, fmt, height, legend }

  function hist(host, spec) {
    const p = palette();
    const last = spec.bins.length - 1;
    const size = spec.bins[0].hi - spec.bins[0].lo;
    const starts = spec.bins.map((b) => b.lo);
    const ranges = spec.bins.map((b) => `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}`);
    const traces = [
      {
        type: "bar",
        name: spec.series.label,
        x: starts,
        y: spec.series.values,
        offset: size * 0.06, // bars fill 88% of their bin, leaving a small gap between neighbours
        width: size * 0.88,
        marker: { color: p.slot(spec.series.slot) },
        customdata: spec.series.values.map((v, j) => [spec.fmt(v), ranges[j]]),
        hovertemplate: `%{customdata[0]}  ${spec.series.label}, scores %{customdata[1]}<extra></extra>`,
      },
    ];
    if (spec.ref) {
      // Step outline along the bin edges; the extra last point closes the final bin.
      const y = [...spec.ref.values, spec.ref.values[last]];
      traces.push({
        type: "scatter",
        mode: "lines",
        name: spec.ref.label,
        x: [...starts, spec.bins[last].hi],
        y,
        line: { shape: "hv", color: p.slot(spec.ref.slot), width: 2 },
        customdata: y.map((v, j) => [spec.fmt(v), ranges[Math.min(j, last)]]),
        hovertemplate: `%{customdata[0]}  ${spec.ref.label}<extra></extra>`,
      });
    }
    const layout = baseLayout(p, { unit: "pct", legend: spec.legend, zero: true, xTitle: "Score" });
    layout.xaxis = { ...layout.xaxis, range: [spec.bins[0].lo, spec.bins[last].hi], dtick: 0.2, hoverformat: ".2f" };
    layout.barcornerradius = 4;
    plot(host, spec.height, spec.name, traces, layout);
  }

  // ---- Sparkline --------------------------------------------------------------------------------------------------
  // Trend in the de-emphasis gray, with the selected cycle marked in the accent color.

  function spark(host, values, sel) {
    const p = palette();
    const x = values.map((_, i) => i);
    const traces = [
      { type: "scatter", mode: "lines", x, y: values, connectgaps: true, line: { color: p.muted, width: 1.5 }, hoverinfo: "skip" },
      { type: "scatter", mode: "markers", x: [sel], y: [values[sel]], marker: { color: p.slot(1), size: 7, line: { color: p.surface, width: 2 } }, hoverinfo: "skip" },
    ];
    const layout = {
      autosize: true,
      margin: { l: 5, r: 5, t: 4, b: 4 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      showlegend: false,
      hovermode: false,
      xaxis: { visible: false, fixedrange: true },
      yaxis: { visible: false, fixedrange: true },
    };
    plot(host, 28, "", traces, layout, { staticPlot: true });
  }

  // ---- Horizontal bars (HTML, so long names truncate cleanly and rows can be buttons) -----------------------------
  // spec: { rows: [{label, value, extras: [text], muted}], fmt, max?, ref?: {value, label}, labelHead, valueHead,
  //         extras: [head], onSelect?(label, rowElement) }

  function bars(host, spec) {
    const width = host.clientWidth;
    if (!width) return;
    host.textContent = "";
    const { rows, fmt, onSelect, ref } = spec;
    // Keep only the extra columns that fit beside the label and the bar; the table view always has all of them.
    const all = spec.extras || [];
    const extras = all.slice(0, Math.max(0, Math.floor((width - 190) / 56)));
    const max = Math.max(spec.max || 0, ref ? ref.value : 0, ...rows.map((r) => r.value || 0)) || 1;
    // The longest bar stops 52px short of the track's end, so every value label fits at its bar's tip.
    const along = (v) => `calc((100% - 52px) * ${Math.max(0, v || 0) / max})`;
    const list = html("div", { class: "hbars" });
    list.style.setProperty("--cols", "minmax(72px, 34%) minmax(90px, 1fr)" + " minmax(44px, auto)".repeat(extras.length));
    list.append(
      html(
        "div",
        { class: "hb-head", "aria-hidden": "true" },
        html("span", { text: spec.labelHead || "" }),
        html("span", { text: spec.valueHead || "" }),
        ...extras.map((e) => html("span", { class: "hb-extra", text: e }))
      )
    );
    for (const r of rows) {
      const value = r.value == null ? "—" : fmt(r.value);
      const fill = html("span", { class: "hb-fill " + (r.muted ? "c-muted" : "c-s1") });
      fill.style.width = along(r.value);
      const track = html("span", { class: "hb-track" }, fill, html("span", { class: "hb-val", text: value }));
      if (ref) {
        const mark = html("span", { class: "hb-ref", "aria-hidden": "true" });
        mark.style.left = along(ref.value);
        track.append(mark);
      }
      const cells = [
        html("span", { class: "hb-label", text: r.label, title: r.label }),
        track,
        ...extras.map((_, k) => html("span", { class: "hb-extra", text: r.extras[k] })),
      ];
      if (onSelect) {
        const said = [spec.valueHead + " " + value, ...all.map((e, k) => e + " " + r.extras[k])].join(", ");
        const row = html("button", { type: "button", class: "hb-row", "aria-label": `${r.label}: ${said}. Show details` }, ...cells);
        row.addEventListener("click", () => onSelect(r.label, row));
        list.append(row);
      } else {
        list.append(html("div", { class: "hb-row" }, ...cells));
      }
    }
    host.append(list);
    if (ref) host.append(html("p", { class: "foot" }, html("span", { class: "hb-refkey", "aria-hidden": "true" }), ref.label));
    if (extras.length < all.length) host.append(html("p", { class: "foot", text: `${all.slice(extras.length).join(", ")}: in the table view.` }));
  }

  // ---- Table view -------------------------------------------------------------------------------------------------

  function table(host, t) {
    host.textContent = "";
    const head = html("tr", {}, ...t.columns.map((c) => html("th", { scope: "col", text: c })));
    const body = t.rows.map((r) =>
      html("tr", {}, ...r.map((v, k) => (k === 0 ? html("th", { scope: "row", text: v }) : html("td", { text: v }))))
    );
    host.append(html("div", { class: "tbl-wrap" }, html("table", { class: "data" }, html("thead", {}, head), html("tbody", {}, ...body))));
  }

  return { html, formats: F, signed, line, stack, hist, spark, bars, table, resize, failed, destroyAll };
})();
