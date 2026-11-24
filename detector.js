// Desk-Mate: misma logica de deteccion que desk_mate_vision/vision_core.py.
// Si cambias un umbral aqui, cambialo tambien alla (y al reves).
export const UMBRALES = {
  parpadeo_cerrado: 0.55, ear_relativo: 0.70, mirada_abajo: 5,
  parpadeo_cerrado_abajo: 0.62, ear_relativo_abajo: 0.20,
  cuello_relativo: 0.78, inclinacion_hombros: 10, inclinacion_cabeza: 15, cabeceo: 20,
  cerca_relativo: 0.75, distancia_min_cm: 40, brillo_min: 45, brillo_relativo: 0.60,
  cuello_dormido: 0.50,
};
export const T_ACTIVAR = { ojos_cerrados: 1.5, dormido: 3, postura: 3, cerca: 3, luz: 3 };
const T_LIBERAR = 1, T_SIN_ROSTRO_POSTURA = 10, T_SIN_ROSTRO_DORMIDO = 15,
  T_CABECEO = 3, T_CIERRE_CABECEO = 1, T_REF_BRILLO = 60;
export const PRIORIDAD = ["dormido", "ojos_cerrados", "postura", "cerca", "luz"];
export const CODIGO = { dormido: 1, ojos_cerrados: 2, postura: 3, cerca: 4, luz: 5 };
export const TONOS = {          // Hz, ms encendido, ms apagado (igual que el buzzer)
  dormido: [2500, 300, 100], ojos_cerrados: [2200, 200, 150], postura: [1500, 250, 350],
  cerca: [1200, 250, 350], luz: [800, 400, 800],
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const grados = (r) => r * 180 / Math.PI;
export const deltaAngulo = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);

const OJO_IZQ = [33, 160, 158, 133, 153, 144], OJO_DER = [362, 385, 387, 263, 373, 380];
function ear(p, i) {
  return (dist(p[i[1]], p[i[5]]) + dist(p[i[2]], p[i[4]])) / (2 * dist(p[i[0]], p[i[3]]) + 1e-6);
}

// Equivale a cv2.RQDecomp3x3. MediaPipe web entrega la matriz 4x4 por columnas.
export function angulosCabeza(d) {
  const r = (f, c) => d[c * 4 + f];
  return {
    pitch: grados(Math.atan2(r(2, 1), r(2, 2))),
    roll: grados(Math.atan2(r(1, 0), r(0, 0))),
  };
}

export function metricasVacias() {
  return { rostro: false, cuerpo: false, ear: NaN, parpadeo: NaN, pitch: NaN, roll: NaN,
    ancho_rostro: NaN, distancia_cm: NaN, cuello: NaN, inclinacion_hombros: NaN, brillo: NaN };
}

export function medir(resRostro, resPose, w, h, brillo, cal) {
  const m = metricasVacias();
  m.brillo = brillo;
  const lm = resRostro.faceLandmarks?.[0];
  if (lm) {
    const p = lm.map((q) => [q.x * w, q.y * h]);
    m.rostro = true;
    m.ear = (ear(p, OJO_IZQ) + ear(p, OJO_DER)) / 2;
    const bs = resRostro.faceBlendshapes?.[0]?.categories;
    if (bs) {
      const v = (n) => bs.find((c) => c.categoryName === n)?.score ?? 0;
      m.parpadeo = (v("eyeBlinkLeft") + v("eyeBlinkRight")) / 2;
    }
    const mat = resRostro.facialTransformationMatrixes?.[0]?.data;
    if (mat) Object.assign(m, angulosCabeza(mat));
    m.ancho_rostro = dist(p[234], p[454]);
    if (cal?.ancho_rostro) {
      m.distancia_cm = cal.distancia_cm * cal.ancho_rostro / Math.max(m.ancho_rostro, 1e-6);
    } else if (p.length > 476) {
      const iris = (dist(p[469], p[471]) + dist(p[474], p[476])) / 2;
      m.distancia_cm = 0.9 * w * 11.7 / Math.max(iris, 1e-6) / 10;
    }
  }
  const lp = resPose.landmarks?.[0];
  if (lp && Math.min(lp[11].visibility, lp[12].visibility) > 0.5) {
    const hi = lp[11], hd = lp[12];
    const ancho = dist([hi.x * w, hi.y * h], [hd.x * w, hd.y * h]) + 1e-6;
    m.cuerpo = true;
    m.cuello = ((hi.y + hd.y) / 2 * h - lp[0].y * h) / ancho;
    m.inclinacion_hombros = grados(Math.atan2((hd.y - hi.y) * h, Math.abs(hd.x - hi.x) * w));
  }
  return m;
}

export function calibrar(muestras, distancia_cm) {
  const cal = { distancia_cm };
  for (const k of ["ear", "cuello", "inclinacion_hombros", "roll", "pitch", "ancho_rostro", "brillo"]) {
    const v = muestras.map((m) => m[k]).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    const n = v.length >> 1;
    cal[k] = v.length ? (v.length % 2 ? v[n] : (v[n - 1] + v[n]) / 2) : null;
  }
  return cal;
}

export class GestorAlertas {
  constructor(cal) {
    this.cal = cal;
    this.inicioCond = {}; this.inicioOk = {}; this.activa = {};
    for (const k of PRIORIDAD) { this.inicioCond[k] = null; this.inicioOk[k] = null; this.activa[k] = false; }
    this.sinRostroDesde = null; this.presente = false; this.sinCuerpoDesde = null;
    this.ojosCerradosEn = null; this.cierreDesde = null; this.cabeceando = false;
    this.brilloRef = cal?.brillo ?? null; this.tBrillo = null;
  }

  condiciones(m, ard, t) {
    const c = this.cal ?? {}, u = UMBRALES;
    const cond = { ojos_cerrados: false, dormido: false, postura: false, cerca: false, luz: false };
    let motivo = "";
    const oscuro = m.brillo < u.brillo_min;
    if (m.rostro && m.cuerpo) this.presente = true;
    if (m.cuerpo || oscuro) this.sinCuerpoDesde = null;
    else {
      this.sinCuerpoDesde ??= t;
      if (t - this.sinCuerpoDesde > 5) this.presente = false;
    }

    // ojos
    if (m.rostro) {
      this.sinRostroDesde = null;
      const abajo = c.pitch != null && deltaAngulo(m.pitch, c.pitch) > u.mirada_abajo;
      const limBs = abajo ? u.parpadeo_cerrado_abajo : u.parpadeo_cerrado;
      const limEar = abajo ? u.ear_relativo_abajo : u.ear_relativo;
      cond.ojos_cerrados = m.parpadeo >= limBs || Boolean(c.ear && m.ear < limEar * c.ear);
      if (cond.ojos_cerrados) {
        this.cierreDesde ??= t;
        if (t - this.cierreDesde >= T_CIERRE_CABECEO) this.ojosCerradosEn = t;
      } else this.cierreDesde = null;
    } else {
      this.cierreDesde = null;
      this.sinRostroDesde ??= t;
    }

    // cabeceo
    if (m.cuerpo && c.cuello) {
      const abajo = m.cuello < u.cuello_dormido * c.cuello;
      if (abajo && this.ojosCerradosEn !== null && t - this.ojosCerradosEn < T_CABECEO) this.cabeceando = true;
      if (!abajo) this.cabeceando = false;
    } else if (!oscuro) this.cabeceando = false;

    // postura
    if (c.cuello && m.cuerpo && m.rostro) {
      const reglas = [
        [m.cuello < u.cuello_relativo * c.cuello, "espalda encorvada"],
        [Math.abs(m.inclinacion_hombros - c.inclinacion_hombros) > u.inclinacion_hombros, "cuerpo inclinado"],
        [deltaAngulo(m.roll, c.roll) > u.inclinacion_cabeza, "cabeza ladeada"],
        [deltaAngulo(m.pitch, c.pitch) > u.cabeceo, "cuello doblado"],
      ];
      const mala = reglas.find((r) => r[0]);
      if (mala) { cond.postura = true; motivo = mala[1]; }
    } else if (c.cuello && m.cuerpo && !m.rostro && this.presente && t - this.sinRostroDesde > T_SIN_ROSTRO_POSTURA) {
      cond.postura = true; motivo = "cabeza agachada";
    }

    // dormido
    const sinRostro = this.sinRostroDesde !== null && m.cuerpo && this.presente &&
      t - this.sinRostroDesde > T_SIN_ROSTRO_DORMIDO;
    const caida = m.rostro && c.pitch != null && deltaAngulo(m.pitch, c.pitch) > u.cabeceo;
    cond.dormido = sinRostro || this.cabeceando || (cond.ojos_cerrados && caida);

    // distancia
    let cerca = false;
    if (m.rostro && !Number.isNaN(m.distancia_cm)) {
      cerca = m.distancia_cm < u.distancia_min_cm ||
        Boolean(c.distancia_cm && m.distancia_cm < u.cerca_relativo * c.distancia_cm);
    }
    cond.cerca = cerca || Boolean(ard && ard.presente === 1 && ard.distancia_cm < u.distancia_min_cm);

    // luz
    let lim = u.brillo_min;
    if (this.brilloRef) lim = Math.max(lim, u.brillo_relativo * this.brilloRef);
    const luzCam = m.brillo < lim;
    if (this.brilloRef && m.rostro && m.brillo >= 0.8 * this.brilloRef) {
      const dt = this.tBrillo !== null ? Math.min(t - this.tBrillo, 1) : 0;
      this.brilloRef += (m.brillo - this.brilloRef) * dt / T_REF_BRILLO;
    }
    this.tBrillo = t;
    cond.luz = (luzCam || Boolean(ard && ard.luz_baja === 1)) && (m.rostro || this.presente);
    return { cond, motivo };
  }

  actualizar(m, ard, t) {
    const { cond, motivo } = this.condiciones(m, ard, t);
    for (const k of PRIORIDAD) {
      if (cond[k]) {
        this.inicioOk[k] = null;
        this.inicioCond[k] ??= t;
        if (t - this.inicioCond[k] >= T_ACTIVAR[k]) this.activa[k] = true;
      } else {
        this.inicioCond[k] = null;
        this.inicioOk[k] ??= t;
        if (t - this.inicioOk[k] >= T_LIBERAR) this.activa[k] = false;
      }
    }
    return { cond, motivo, activas: PRIORIDAD.filter((k) => this.activa[k]) };
  }
}

// ---------- Trama CSV del Arduino ----------
const CAMPOS = ["t_ms", "distancia_cm", "luz", "temp_c", "hum_pct", "presente", "min_sesion",
  "postura", "luz_baja", "ambiente", "pausa60", "alerta120"];
export function parsearTrama(linea) {
  const p = linea.trim().split(",");
  if (p.length !== CAMPOS.length || !/^\d+$/.test(p[0])) return null;
  const v = p.map(Number);
  return v.some(Number.isNaN) ? null : Object.fromEntries(CAMPOS.map((k, i) => [k, v[i]]));
}
