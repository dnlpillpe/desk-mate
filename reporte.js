// Calculos del tablero. Sin DOM, para poder probarlos aparte.
import { GestorAlertas, PRIORIDAD, UMBRALES as U, metricasVacias } from "./detector.js";

export const ALERTAS = [
  ["alerta_dormido", "Dormido", "Cámara"], ["alerta_ojos_cerrados", "Ojos cerrados", "Cámara"],
  ["alerta_postura", "Mala postura", "Cámara"], ["alerta_cerca", "Muy cerca", "Cámara y HC-SR04"],
  ["alerta_luz", "Poca luz", "Cámara y LDR"],
  ["ard_postura", "Cerca más de 10 s", "HC-SR04"], ["ard_luz_baja", "Luz baja", "LDR"],
  ["ard_ambiente", "Ambiente fuera de rango", "LDR y DHT11"],
  ["ard_pausa60", "60 min sin pausa", "Sesión"], ["ard_alerta120", "120 min sin pausa", "Sesión"],
];
export const N_CAMARA = 5;

const rel = (c, k, f) => (c?.[k] != null ? f(c[k]) : {});
// limites: lo = alerta por debajo, hi = alerta por encima
export const METRICAS = [
  { k: "distancia_cm", n: "Distancia a la pantalla", u: "cm", d: 0, f: "Cámara", lim: (c) => ({ lo: Math.max(U.distancia_min_cm, U.cerca_relativo * (c?.distancia_cm ?? 0)) }) },
  { k: "cuello", n: "Altura del cuello", u: "", d: 2, f: "Cámara", lim: (c) => rel(c, "cuello", (v) => ({ lo: U.cuello_relativo * v })) },
  { k: "inclinacion_hombros", n: "Inclinación de hombros", u: "°", d: 1, f: "Cámara", lim: (c) => rel(c, "inclinacion_hombros", (v) => ({ lo: v - U.inclinacion_hombros, hi: v + U.inclinacion_hombros })) },
  { k: "pitch", n: "Cabeza arriba/abajo", u: "°", d: 1, f: "Cámara", ang: true, lim: (c) => rel(c, "pitch", (v) => ({ lo: v - U.cabeceo, hi: v + U.cabeceo })) },
  { k: "roll", n: "Cabeza ladeada", u: "°", d: 1, f: "Cámara", ang: true, lim: (c) => rel(c, "roll", (v) => ({ lo: v - U.inclinacion_cabeza, hi: v + U.inclinacion_cabeza })) },
  { k: "ear", n: "Apertura del ojo (EAR)", u: "", d: 2, f: "Cámara", lim: (c) => rel(c, "ear", (v) => ({ lo: U.ear_relativo * v })) },
  { k: "parpadeo", n: "Cierre de párpados", u: "", d: 2, f: "Cámara", lim: () => ({ hi: U.parpadeo_cerrado }) },
  { k: "ancho_rostro", n: "Ancho del rostro", u: "px", d: 0, f: "Cámara", lim: () => ({}) },
  { k: "brillo", n: "Brillo de la imagen", u: "/255", d: 0, f: "Cámara", lim: (c) => ({ lo: Math.max(U.brillo_min, U.brillo_relativo * (c?.brillo ?? 0)) }) },
  { k: "ard_distancia_cm", n: "Distancia (HC-SR04)", u: "cm", d: 0, f: "Arduino", lim: () => ({ lo: 40 }) },
  { k: "ard_luz", n: "Luz ambiental (LDR)", u: "/1023", d: 0, f: "Arduino", lim: () => ({ lo: 300 }) },
  { k: "ard_temp_c", n: "Temperatura (DHT11)", u: "°C", d: 1, f: "Arduino", lim: () => ({ lo: 20, hi: 26 }) },
  { k: "ard_hum_pct", n: "Humedad (DHT11)", u: "%", d: 0, f: "Arduino", lim: () => ({ lo: 40, hi: 60 }) },
  { k: "ard_min_sesion", n: "Minutos sin pausa", u: "min", d: 0, f: "Arduino", lim: () => ({ hi: 60, incluye: true }) },
];

// Columnas iguales a registros/vision_AAAAMMDD.csv del programa de Python
const MED = Object.keys(metricasVacias());
const ARD = ["t_ms", "distancia_cm", "luz", "temp_c", "hum_pct", "presente", "min_sesion", "postura", "luz_baja", "ambiente", "pausa60", "alerta120"];
export const COLUMNAS = ["fecha_hora", ...MED, ...PRIORIDAD.map((k) => `alerta_${k}`), "motivo_postura", ...ARD.map((k) => `ard_${k}`)];

export function crearFila(t, m, activas, motivo, ard) {
  const f = { t };
  for (const k of MED) f[k] = m ? (Number.isNaN(m[k]) ? null : m[k]) : null;
  for (const k of PRIORIDAD) f[`alerta_${k}`] = activas.includes(k) ? 1 : 0;
  f.motivo_postura = motivo || "";
  for (const k of ARD) f[`ard_${k}`] = ard ? ard[k] : null;
  return f;
}

// valor util de una metrica: sin eco y sensor sin lectura no cuentan
export function valor(f, met, cal) {
  let v = f[met.k];
  if (v == null || Number.isNaN(v)) return null;
  if (met.k === "ard_distancia_cm" && v >= 999) return null;
  if ((met.k === "ard_temp_c" || met.k === "ard_hum_pct") && f.ard_temp_c === 0 && f.ard_hum_pct === 0) return null;
  if (met.k === "inclinacion_hombros" && Math.abs(v) > 90) v = Math.sign(v) * (180 - Math.abs(v));
  if (met.ang && cal?.[met.k] != null) v = cal[met.k] + ((((v - cal[met.k] + 180) % 360) + 360) % 360 - 180);
  return v;
}
export function fuera(v, l) {
  return (l.lo != null && v < l.lo) || (l.hi != null && (l.incluye ? v >= l.hi : v > l.hi));
}

// segundos que representa cada fila (los huecos no se cuentan)
export function duraciones(filas) {
  return filas.map((f, i) => {
    const s = i + 1 < filas.length ? (filas[i + 1].t - f.t) / 1000 : 1;
    return s > 0 && s <= 3 ? s : 1;
  });
}

export function resumir(filas, cal) {
  const dt = duraciones(filas);
  const total = dt.reduce((a, b) => a + b, 0);
  let enAlerta = 0, conRostro = 0, sCamara = 0, sArduino = 0;
  const motivos = {};
  filas.forEach((f, i) => {
    if (ALERTAS.slice(0, N_CAMARA).some(([k]) => f[k])) enAlerta += dt[i];
    if (f.brillo != null) { sCamara += dt[i]; if (f.rostro) conRostro += dt[i]; }
    if (f.ard_t_ms != null) sArduino += dt[i];
    if (f.alerta_postura && f.motivo_postura) motivos[f.motivo_postura] = (motivos[f.motivo_postura] ?? 0) + dt[i];
  });
  const alertas = ALERTAS.map(([k, n, origen]) => {
    const tramos = [];
    let a = null;
    filas.forEach((f, i) => {
      const corte = i > 0 && f.t - filas[i - 1].t > 3000;
      if (a && (!f[k] || corte)) { tramos.push(a); a = null; }
      if (f[k]) { a ??= { i, desde: f.t, s: 0, hasta: f.t }; a.s += dt[i]; a.hasta = f.t + dt[i] * 1000; }
    });
    if (a) tramos.push(a);
    return { k, n, origen, veces: tramos.length, segundos: tramos.reduce((x, y) => x + y.s, 0),
      mayor: tramos.reduce((x, y) => Math.max(x, y.s), 0), tramos };
  });
  const metricas = METRICAS.map((met) => {
    const lim = met.lim(cal);
    let n = 0, suma = 0, min = Infinity, max = -Infinity, malos = 0, seg = 0;
    filas.forEach((f, i) => {
      const v = valor(f, met, cal);
      if (v === null) return;
      n++; suma += v; seg += dt[i];
      min = Math.min(min, v); max = Math.max(max, v);
      if (fuera(v, lim)) malos += dt[i];
    });
    const hayLim = lim.lo != null || lim.hi != null;
    return { met, lim, n, prom: n ? suma / n : null, min: n ? min : null, max: n ? max : null,
      pctFuera: n && hayLim ? 100 * malos / seg : null };
  });
  return { total, enAlerta, sCamara, sArduino, alertas, metricas,
    pctBien: sCamara ? 100 * Math.max(0, sCamara - enAlerta) / sCamara : null,
    pctRostro: sCamara ? 100 * conRostro / sCamara : null,
    veces: alertas.slice(0, N_CAMARA).reduce((a, b) => a + b.veces, 0),
    motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]) };
}

// ---------- CSV ----------
const dd = (n) => String(n).padStart(2, "0");
export function fechaHora(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())} ${dd(d.getHours())}:${dd(d.getMinutes())}:${dd(d.getSeconds())}`;
}
export function aCsv(filas) {
  const celda = (f, c) => {
    if (c === "fecha_hora") return fechaHora(f.t);
    const v = f[c];
    if (c === "rostro" || c === "cuerpo") return v ? "True" : "False";
    if (v == null) return MED.includes(c) ? "nan" : "";
    if (c === "motivo_postura") return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    return String(Math.round(v * 1000) / 1000);
  };
  return [COLUMNAS.join(","), ...filas.map((f) => COLUMNAS.map((c) => celda(f, c)).join(","))].join("\r\n") + "\r\n";
}
export function leerCsv(texto) {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cab = (lineas.shift() ?? "").split(",");
  if (!["fecha_hora", "ear", "alerta_postura"].every((c) => cab.includes(c))) return null;
  const filas = [];
  for (const l of lineas) {
    const p = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
    const o = Object.fromEntries(cab.map((c, i) => [c, p[i] ?? ""]));
    const t = new Date(o.fecha_hora.replace(" ", "T")).getTime();
    if (Number.isNaN(t)) continue;
    const f = { t };
    for (const c of COLUMNAS.slice(1)) {
      if (c === "motivo_postura") f[c] = o[c] ?? "";
      else if (c === "rostro" || c === "cuerpo") f[c] = o[c] === "True";
      else { const v = o[c] === undefined || o[c] === "" ? NaN : Number(o[c]); f[c] = Number.isNaN(v) ? null : v; }
    }
    filas.push(f);
  }
  return filas.sort((a, b) => a.t - b.t);
}
// un archivo puede traer varias sesiones: se separan por pausas de mas de 60 s
export function separar(filas) {
  const s = [];
  for (const f of filas) {
    const u = s.at(-1);
    if (!u || f.t - u.at(-1).t > 60000) s.push([f]); else u.push(f);
  }
  return s;
}

// ---------- Sesion de ejemplo (simulada, pasa por las reglas reales) ----------
export function ejemplo() {
  const cal = { ear: 0.3, cuello: 0.55, inclinacion_hombros: 0, roll: 1, pitch: 5, ancho_rostro: 130, brillo: 150, distancia_cm: 60 };
  const g = new GestorAlertas(cal);
  const t0 = new Date(2026, 10, 20, 19, 0, 0).getTime();
  const filas = [];
  let sem = 7;
  const r = () => { sem = (sem * 16807) % 2147483647; return sem / 2147483647 - 0.5; };
  for (let s = 0; s < 900; s++) {
    const en = (a, b) => s >= a && s < b;
    const m = { rostro: true, cuerpo: true, ear: 0.3 + r() * 0.03, parpadeo: 0.08 + r() * 0.08, pitch: 5 + r() * 4,
      roll: 1 + r() * 4, ancho_rostro: 0, distancia_cm: 60 - s / 150 + r() * 3, cuello: 0.55 - s / 14000 + r() * 0.03,
      inclinacion_hombros: r() * 4, brillo: 150 + r() * 6 };
    if (en(150, 176)) m.cuello = 0.36 + r() * 0.02;
    if (en(300, 318)) m.distancia_cm = 37 + r() * 2;
    if (en(420, 440)) m.inclinacion_hombros = 15 + r() * 2;
    if (en(530, 536)) { m.ear = 0.04; m.parpadeo = 0.7; }
    if (en(620, 660)) m.brillo = 70 + r() * 4;
    if (en(740, 750)) { m.ear = 0.04; m.parpadeo = 0.72; m.pitch = 30; m.cuello = 0.4; }
    if (en(820, 846)) m.cuello = 0.38 + r() * 0.02;
    m.ancho_rostro = 60 * 130 / m.distancia_cm;
    const oscuro = en(620, 660);
    const luz = oscuro ? 180 + r() * 10 : 620 + r() * 20, hum = 52 + s / 300 + r() * 2, temp = 24 + s / 500 + r() * 0.3;
    const ard = { t_ms: s * 1000, distancia_cm: m.distancia_cm + 3 + r() * 2, luz: Math.round(luz), temp_c: temp, hum_pct: Math.round(hum),
      presente: 1, min_sesion: Math.floor(s / 60), postura: en(312, 318) ? 1 : 0, luz_baja: oscuro ? 1 : 0,
      ambiente: oscuro || temp > 26 ? 1 : 0, pausa60: 0, alerta120: 0 };
    const e = g.actualizar(m, ard, s);
    filas.push(crearFila(t0 + s * 1000, m, e.activas, e.motivo, ard));
  }
  return { id: "ejemplo", cal, filas, nombre: "Ejemplo con datos simulados" };
}
