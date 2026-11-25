import { N_CAMARA, crearFila, valor, resumir, aCsv, leerCsv, separar, ejemplo, fechaHora } from "./reporte.js";

const $ = (id) => document.getElementById(id);
const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
const num = (v, d = 0, u = "") => (v == null ? "—" : v.toFixed(d).replace(".", ",") + (u ? (u === "°" || u.startsWith("/") ? "" : " ") + u : ""));
const tiempo = (s) => {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const hora = (t) => fechaHora(t).slice(11);

// ---------- Almacen local (IndexedDB). Si no esta disponible, solo en memoria ----------
const MAX_SESIONES = 20;
const pedir = (r) => new Promise((ok, mal) => { r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error); });
const bd = new Promise((ok) => {
  try {
    const r = indexedDB.open("deskmate", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("sesiones", { keyPath: "id" });
      r.result.createObjectStore("filas", { keyPath: ["sid", "t"] });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = r.onblocked = () => ok(null);
  } catch { ok(null); }
});
const rango = (sid) => IDBKeyRange.bound([sid, 0], [sid, Infinity]);
async function guardar(sesion, filas) {
  const b = await bd;
  if (!b) return;
  try {
    const tx = b.transaction(["sesiones", "filas"], "readwrite");
    const { filas: _, ...meta } = sesion;
    tx.objectStore("sesiones").put(meta);
    for (const f of filas) tx.objectStore("filas").put({ sid: sesion.id, ...f });
  } catch (e) { console.warn("No se pudo guardar la medición", e); }
}
async function borrarSesion(id) {
  const b = await bd;
  if (!b) return;
  const tx = b.transaction(["sesiones", "filas"], "readwrite");
  tx.objectStore("sesiones").delete(id);
  tx.objectStore("filas").delete(rango(id));
  await new Promise((ok, mal) => { tx.oncomplete = ok; tx.onerror = () => mal(tx.error); });
}

const sesiones = new Map();      // id -> { id, inicio, cal, nombre, filas? }
const demo = ejemplo();
let elegida = "ejemplo", actual = null, ultimaFila = 0;

async function cargarFilas(s) {
  if (s.filas) return s.filas;
  const b = await bd;
  s.filas = b ? await pedir(b.transaction("filas").objectStore("filas").getAll(rango(s.id))) : [];
  return s.filas;
}

// ---------- Registro: una fila por segundo mientras haya camara o Arduino ----------
export function anotar(m, activas, motivo, ard, cal) {
  const t = Date.now();
  if (!actual || t - ultimaFila > 15000) {
    actual = { id: `s${t}`, inicio: t, cal, nombre: `Sesión ${fechaHora(t).slice(0, 16)}`, filas: [] };
    sesiones.set(actual.id, actual);
    elegida = actual.id;
    llenarSelector();
    podar();
  }
  if (cal && m) actual.cal = cal;
  ultimaFila = t;
  const f = crearFila(t, m, activas, motivo, ard);
  actual.filas.push(f);
  guardar(actual, [f]);
}
async function podar() {
  const viejas = [...sesiones.values()].sort((a, b) => b.inicio - a.inicio).slice(MAX_SESIONES);
  for (const s of viejas) { sesiones.delete(s.id); await borrarSesion(s.id).catch(() => {}); }
  if (viejas.length) llenarSelector();
}
export async function borrarTodo() {
  for (const id of [...sesiones.keys()]) await borrarSesion(id).catch(() => {});
  sesiones.clear(); actual = null; elegida = "ejemplo";
  llenarSelector(); pintar();
}

function llenarSelector() {
  const sel = $("t-sesion");
  sel.replaceChildren();
  for (const s of [...sesiones.values()].sort((a, b) => b.inicio - a.inicio)) sel.append(new Option(s.nombre, s.id));
  sel.append(new Option(demo.nombre, "ejemplo"));
  sel.value = elegida;
}

// ---------- Graficos SVG ----------
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, at = {}, txt) => {
  const e = document.createElementNS(NS, tag);
  for (const k in at) e.setAttribute(k, at[k]);
  if (txt != null) e.textContent = txt;
  return e;
};
const tip = $("t-tip");
function mostrarTip(ev, lineas) {
  tip.replaceChildren(...lineas.map((l, i) => el(i ? "span" : "b", l)));
  tip.hidden = false;
  const x = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = ev.clientY - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y < 8 ? ev.clientY + 18 : y}px`;
}
const ocultarTip = () => { tip.hidden = true; };

// agrupa la serie en tramos para dibujar sesiones largas; los huecos cortan la linea
function puntos(filas, met, cal, n = 200) {
  const t0 = filas[0].t, t1 = Math.max(filas.at(-1).t, t0 + 1000), paso = Math.max(1000, (t1 - t0) / n);
  const grupos = new Map();
  for (const f of filas) {
    const v = valor(f, met, cal);
    if (v === null) continue;
    const g = Math.floor((f.t - t0) / paso);
    const a = grupos.get(g) ?? { t: 0, v: 0, n: 0 };
    a.t += f.t; a.v += v; a.n++;
    grupos.set(g, a);
  }
  const p = [...grupos.values()].map((a) => ({ t: a.t / a.n, v: a.v / a.n }));
  return { p, t0, t1, corte: Math.max(5000, paso * 2.5) };
}

function graficoLinea(filas, r, cal) {
  const { met, lim } = r;
  const W = 340, H = 150, L = 42, R = 8, T = 10, B = 24;
  const { p, t0, t1, corte } = puntos(filas, met, cal);
  const vs = p.map((q) => q.v).concat([lim.lo, lim.hi].filter((v) => v != null));
  let a = Math.min(...vs), b = Math.max(...vs);
  const aire = (b - a) * 0.1 || Math.abs(a) * 0.1 || 1;
  a -= aire; b += aire;
  const x = (t) => L + (t - t0) / (t1 - t0) * (W - L - R), y = (v) => T + (b - v) / (b - a) * (H - T - B);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "g-linea", role: "img", "aria-label": `${met.n}: promedio ${num(r.prom, met.d, met.u)}, mínimo ${num(r.min, met.d, met.u)}, máximo ${num(r.max, met.d, met.u)}` });
  for (const v of [a + aire, (a + b) / 2, b - aire]) {
    s.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g-reja" }),
      svg("text", { x: L - 6, y: y(v) + 4, class: "g-eje", "text-anchor": "end" }, num(v, met.d)));
  }
  s.append(svg("text", { x: L, y: H - 6, class: "g-eje" }, hora(t0)), svg("text", { x: W - R, y: H - 6, class: "g-eje", "text-anchor": "end" }, hora(t1)));
  for (const v of [lim.lo, lim.hi]) if (v != null) s.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g-limite" }));
  let d = "", previo = null;
  for (const q of p) { d += `${previo === null || q.t - previo > corte ? "M" : "L"}${x(q.t).toFixed(1)} ${y(q.v).toFixed(1)}`; previo = q.t; }
  s.append(svg("path", { d, class: "g-serie" }));
  const cruz = svg("line", { y1: T, y2: H - B, class: "g-cruz", visibility: "hidden" });
  const pt = svg("circle", { r: 4.5, class: "g-punto", visibility: "hidden" });
  s.append(cruz, pt);
  s.addEventListener("pointermove", (ev) => {
    const caja = s.getBoundingClientRect(), t = t0 + ((ev.clientX - caja.left) / caja.width * W - L) / (W - L - R) * (t1 - t0);
    const q = p.reduce((m, c) => (Math.abs(c.t - t) < Math.abs(m.t - t) ? c : m), p[0]);
    for (const k of ["x1", "x2"]) cruz.setAttribute(k, x(q.t));
    pt.setAttribute("cx", x(q.t)); pt.setAttribute("cy", y(q.v));
    cruz.setAttribute("visibility", "visible"); pt.setAttribute("visibility", "visible");
    mostrarTip(ev, [num(q.v, met.d, met.u), hora(q.t)]);
  });
  s.addEventListener("pointerleave", () => { cruz.setAttribute("visibility", "hidden"); pt.setAttribute("visibility", "hidden"); ocultarTip(); });
  return s;
}

function graficoCronologia(filas, alertas) {
  const caja = el("div", null, "crono");
  const t0 = filas[0].t, t1 = Math.max(filas.at(-1).t + 1000, t0 + 1000);
  for (const a of alertas) {
    const pista = el("div", null, "crono-pista");
    for (const tr of a.tramos) {
      const b = el("i");
      b.style.left = `${100 * (tr.desde - t0) / (t1 - t0)}%`;
      b.style.width = `max(4px, ${100 * (tr.hasta - tr.desde) / (t1 - t0)}%)`;
      b.addEventListener("pointermove", (ev) => mostrarTip(ev, [`${a.n}: ${tiempo(tr.s)}`, `Desde ${hora(tr.desde)}`]));
      b.addEventListener("pointerleave", ocultarTip);
      pista.append(b);
    }
    caja.append(el("span", a.n, "crono-nombre"), pista);
  }
  const eje = el("div", null, "crono-eje");
  eje.append(el("span", hora(t0)), el("span", hora(t1)));
  caja.append(el("span"), eje);
  return caja;
}

function tabla(cabeceras, filas, titulo) {
  const t = el("table"), th = el("thead"), tr = el("tr"), tb = el("tbody");
  t.append(el("caption", titulo, "oculto"));
  for (const c of cabeceras) { const h = el("th", c); h.scope = "col"; tr.append(h); }
  th.append(tr);
  for (const f of filas) {
    const r = el("tr");
    f.forEach((c, i) => { const e = el(i ? "td" : "th", c); if (!i) e.scope = "row"; r.append(e); });
    tb.append(r);
  }
  t.append(th, tb);
  return t;
}

function textoLimite({ met, lim }) {
  const a = lim.lo != null ? num(lim.lo, met.d, met.u) : null, b = lim.hi != null ? num(lim.hi, met.d, met.u) : null;
  if (a && b) return `${a} a ${b}`;
  if (a) return `Desde ${a}`;
  if (b) return lim.incluye ? `Menos de ${b}` : `Hasta ${b}`;
  return "Sin límite";
}

// ---------- Pintado ----------
let turno = 0;
async function pintar() {
  const mio = ++turno;
  const s = elegida === "ejemplo" ? demo : sesiones.get(elegida);
  if (!s) return;
  const filas = await cargarFilas(s);
  if (mio !== turno) return;
  ocultarTip();
  const esDemo = s === demo, viva = s === actual && Date.now() - ultimaFila < 3000;
  $("t-aviso").textContent = esDemo
    ? "Estás viendo datos simulados. Enciende la cámara o conecta el Arduino para generar tu propio reporte."
    : viva ? "Grabando esta sesión. El reporte se actualiza cada 2 segundos."
      : s.cal ? "Sesión terminada." : "Sin calibración: los límites que dependen de tu postura no se muestran.";
  $("t-aviso").className = esDemo ? "t-aviso t-demo" : "t-aviso";
  $("t-borrar").disabled = esDemo;
  $("t-cuerpo").hidden = !filas.length;
  if (!filas.length) { $("t-aviso").textContent = "Esta sesión no tiene mediciones."; return; }

  const R = resumir(filas, s.cal);
  const cam = R.alertas.slice(0, N_CAMARA), top = cam.reduce((a, b) => (b.segundos > a.segundos ? b : a), cam[0]);
  $("t-periodo").textContent = `${fechaHora(filas[0].t)} a ${hora(filas.at(-1).t)}`;
  $("t-bien").textContent = R.pctBien == null ? "—" : `${Math.round(R.pctBien)} %`;
  $("t-tiempo").textContent = tiempo(R.total);
  $("t-veces").textContent = R.sCamara ? String(R.veces) : "—";
  $("t-enalerta").textContent = R.sCamara ? tiempo(R.enAlerta) : "—";
  $("t-top").textContent = R.sCamara ? (top.segundos ? top.n : "Ninguna") : "—";
  $("t-fuentes").textContent = `Cámara ${tiempo(R.sCamara)} (rostro visible ${R.pctRostro == null ? "—" : Math.round(R.pctRostro) + " %"}). Arduino ${tiempo(R.sArduino)}.`;

  const visibles = R.alertas.filter((a, i) => (i < N_CAMARA ? R.sCamara : R.sArduino));
  $("t-crono").replaceChildren(graficoCronologia(filas, visibles));
  $("t-alertas").replaceChildren(tabla(["Alerta", "Origen", "Veces", "Tiempo total", "Más larga", "% de la sesión"],
    visibles.map((a) => [a.n, a.origen, String(a.veces), tiempo(a.segundos), tiempo(a.mayor), num(100 * a.segundos / R.total, 1, "%")]), "Alertas de la sesión"));

  const maxMot = R.motivos[0]?.[1] ?? 1;
  $("t-motivos").replaceChildren(...(R.motivos.length ? R.motivos.map(([n, sg]) => {
    const f = el("div", null, "barra-fila"), p = el("span", null, "barra-pista"), b = el("i");
    b.style.width = `${100 * sg / maxMot}%`;
    p.append(b); f.append(el("span", n[0].toUpperCase() + n.slice(1)), p, el("b", tiempo(sg)));
    return f;
  }) : [el("p", "No hubo alertas de postura.")]));

  for (const [fuente, id] of [["Cámara", "t-g-camara"], ["Arduino", "t-g-arduino"]]) {
    const con = R.metricas.filter((r) => r.met.f === fuente && r.n);
    $(id).replaceChildren(...(con.length ? con.map((r) => {
      const f = el("figure"), c = el("figcaption");
      c.append(el("span", r.met.n), el("b", num(r.prom, r.met.d, r.met.u)));
      f.append(c, graficoLinea(filas, r, s.cal), el("p", `Adecuado: ${textoLimite(r)}`, "g-nota"));
      return f;
    }) : [el("p", fuente === "Arduino" ? "El Arduino no estuvo conectado en esta sesión." : "La cámara no estuvo encendida en esta sesión.")]));
  }
  $("t-metricas").replaceChildren(tabla(["Métrica", "Fuente", "Promedio", "Mínimo", "Máximo", "Rango adecuado", "Tiempo fuera"],
    R.metricas.map((r) => [r.met.n, r.met.f, num(r.prom, r.met.d, r.met.u), num(r.min, r.met.d, r.met.u), num(r.max, r.met.d, r.met.u), textoLimite(r), r.pctFuera == null ? "—" : num(r.pctFuera, 1, "%")]), "Resumen de todas las métricas"));
}

// ---------- Controles ----------
$("t-sesion").addEventListener("change", (e) => { elegida = e.target.value; rearmarBorrar(); pintar(); });
$("t-csv").addEventListener("click", async () => {
  const s = elegida === "ejemplo" ? demo : sesiones.get(elegida);
  const filas = await cargarFilas(s);
  if (!filas.length) return;
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([aCsv(filas)], { type: "text/csv" }));
  a.download = `desk-mate_${s === demo ? "ejemplo" : fechaHora(filas[0].t).replace(/[: ]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("t-imprimir").addEventListener("click", () => window.print());
$("t-archivo").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  e.target.value = "";
  if (!archivo) return;
  const filas = leerCsv(await archivo.text());
  if (!filas?.length) { $("t-aviso").textContent = "Ese archivo no es un registro de Desk-Mate (vision_AAAAMMDD.csv)."; return; }
  const partes = separar(filas);
  partes.forEach((p, i) => {
    const s = { id: `i${p[0].t}`, inicio: p[0].t, cal: null, nombre: `Importada ${fechaHora(p[0].t).slice(0, 16)}`, filas: p };
    sesiones.set(s.id, s);
    guardar(s, p);
    if (i === partes.length - 1) elegida = s.id;
  });
  await podar();
  if (!sesiones.has(elegida)) elegida = [...sesiones.keys()].at(-1) ?? "ejemplo";
  llenarSelector(); pintar();
});
let confirmando = false;
function rearmarBorrar() { confirmando = false; $("t-borrar").textContent = "Borrar sesión"; }
$("t-borrar").addEventListener("click", async () => {
  if (!confirmando) { confirmando = true; $("t-borrar").textContent = "¿Borrar? Pulsa otra vez"; setTimeout(rearmarBorrar, 4000); return; }
  rearmarBorrar();
  const id = elegida;
  if (actual?.id === id) actual = null;
  sesiones.delete(id);
  await borrarSesion(id).catch(() => {});
  elegida = [...sesiones.values()].sort((a, b) => b.inicio - a.inicio)[0]?.id ?? "ejemplo";
  llenarSelector(); pintar();
});

let aLaVista = false;
new IntersectionObserver((e) => { aLaVista = e[0].isIntersecting; if (aLaVista) pintar(); }).observe($("tablero"));
setInterval(() => {
  if (aLaVista && !document.hidden && actual && elegida === actual.id && Date.now() - ultimaFila < 4000 && tip.hidden) pintar();
}, 2000);

(async () => {
  llenarSelector();
  pintar();
  const b = await bd;
  if (!b) return;
  try {
    const guardadas = await pedir(b.transaction("sesiones").objectStore("sesiones").getAll());
    for (const s of guardadas) if (!sesiones.has(s.id)) sesiones.set(s.id, s);
    const reciente = guardadas.sort((x, y) => y.inicio - x.inicio)[0];
    if (reciente && elegida === "ejemplo") elegida = reciente.id;
    llenarSelector(); pintar();
  } catch (e) { console.warn(e); }
})();
