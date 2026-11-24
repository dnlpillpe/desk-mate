import { GestorAlertas, PRIORIDAD, CODIGO, TONOS, medir, calibrar, parsearTrama } from "./detector.js";

const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3";
const $ = (id) => document.getElementById(id);
const MENSAJES = {
  dormido: "Despierta: te estás quedando dormido",
  ojos_cerrados: "Abre los ojos",
  postura: "Endereza la espalda y el cuello",
  cerca: "Aléjate de la pantalla",
  luz: "Enciende una luz",
};

// ---------- Sonido ----------
let audio = null;
function tono(hz, ms, volumen = 0.15) {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
  o.type = "square"; o.frequency.value = hz; g.gain.value = volumen;
  o.connect(g).connect(audio.destination);
  o.start(t); o.stop(t + ms / 1000);
}
function activarAudio() { audio ??= new AudioContext(); audio.resume(); }
let sonido = true, proximoTono = 0;
function sonar(alerta) {
  const ahora = performance.now();
  if (!alerta || !sonido || ahora < proximoTono) return;
  const [hz, on, off] = TONOS[alerta];
  tono(hz, on);
  proximoTono = ahora + on + off;
}

// ---------- Escena del inicio ----------
const ESCENA = {
  bien: "Buena postura. Todo en verde.",
  postura: "Mala postura: endereza la espalda.",
  dormido: "Dormido: la alarma no para hasta que levantes la cabeza.",
  ojos_cerrados: "Ojos cerrados por más de 1,5 segundos.",
  cerca: "Muy cerca: menos de 40 cm de la pantalla.",
  luz: "Luz insuficiente: enciende la lámpara.",
};
$("escena").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-pose]");
  if (!b) return;
  const pose = b.dataset.pose;
  $("escena").dataset.pose = pose;
  $("escena-aviso").textContent = ESCENA[pose];
  for (const x of $("escena").querySelectorAll("button")) x.setAttribute("aria-pressed", x === b);
  if (TONOS[pose]) { activarAudio(); tono(TONOS[pose][0], TONOS[pose][1]); }
});

// ---------- Calibracion (solo en este navegador) ----------
const CLAVE = "deskmate-calibracion";
function leerCal() { try { return JSON.parse(localStorage.getItem(CLAVE)); } catch { return null; } }
function guardarCal(c) { try { localStorage.setItem(CLAVE, JSON.stringify(c)); } catch { /* sin almacenamiento */ } }
$("btn-borrar").addEventListener("click", () => {
  try { localStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ }
  cal = null;
  gestor = new GestorAlertas(null);
  if (flujo) iniciarCalibracion();
  $("btn-borrar").textContent = "Calibración borrada";
});

// ---------- Camara y modelo ----------
let rostro, pose, dibujo, Vision, flujo = null, encendiendo = false, ultimoTs = 0;
let cal = leerCal(), gestor = new GestorAlertas(cal), calibracion = null;
const video = document.createElement("video");
video.muted = true; video.playsInline = true;
const lienzo = $("lienzo"), ctx = lienzo.getContext("2d");
const mini = document.createElement("canvas"); mini.width = 64; mini.height = 48;
const mctx = mini.getContext("2d", { willReadFrequently: true });

async function cargarModelo() {
  if (pose) return;
  Vision = await import(`${CDN}/vision_bundle.mjs`);
  const archivos = await Vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const crear = async (delegate) => {
    rostro = await Vision.FaceLandmarker.createFromOptions(archivos, {
      baseOptions: { modelAssetPath: "modelos/face_landmarker.task", delegate },
      runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    pose = await Vision.PoseLandmarker.createFromOptions(archivos, {
      baseOptions: { modelAssetPath: "modelos/pose_landmarker_lite.task", delegate },
      runningMode: "VIDEO", numPoses: 1,
    });
  };
  try { await crear("GPU"); } catch { await crear("CPU"); }
  dibujo = new Vision.DrawingUtils(ctx);
}

function mensajeError(e) {
  if (e?.name === "NotAllowedError") return "El navegador no tiene permiso para usar la cámara. Actívalo en el candado de la barra de direcciones.";
  if (e?.name === "NotFoundError") return "No se encontró ninguna cámara en este equipo.";
  if (e?.name === "NotReadableError") return "Otra aplicación está usando la cámara. Ciérrala y vuelve a intentar.";
  if (!navigator.mediaDevices) return "La cámara solo funciona en una página https o en localhost.";
  return "No se pudo cargar el modelo. Revisa tu conexión a internet y vuelve a intentar.";
}

$("btn-iniciar").addEventListener("click", async () => {
  if (encendiendo || flujo) return;
  encendiendo = true;
  activarAudio();
  $("btn-iniciar").hidden = true;
  $("visor-texto").textContent = "Esperando permiso para usar la cámara…";
  let nuevo = null;
  try {
    nuevo = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
    $("visor-texto").textContent = "Cargando el modelo… la primera vez tarda unos segundos.";
    await cargarModelo();
    video.srcObject = nuevo;
    await video.play();
    flujo = nuevo;
    nuevo.getVideoTracks()[0].onended = detener;
    lienzo.width = video.videoWidth; lienzo.height = video.videoHeight;
    $("visor-inicio").hidden = true;
    for (const id of ["btn-calibrar", "btn-sonido", "btn-detener"]) $(id).disabled = false;
    gestor = new GestorAlertas(cal);
    if (cal) $("estado").textContent = "Vigilando con tu calibración guardada";
    else iniciarCalibracion();
    reloj.postMessage("iniciar");
  } catch (e) {
    console.error(e);
    nuevo?.getTracks().forEach((t) => t.stop());
    $("btn-iniciar").hidden = false;
    $("visor-texto").textContent = mensajeError(e);
  }
  encendiendo = false;
});

function detener() {
  reloj.postMessage("parar");
  flujo?.getTracks().forEach((t) => t.stop());
  flujo = null; calibracion = null; video.srcObject = null;
  ctx.clearRect(0, 0, lienzo.width, lienzo.height);
  $("visor-inicio").hidden = false; $("btn-iniciar").hidden = false;
  $("visor-texto").textContent = "Siéntate derecho, con el rostro y los hombros visibles.";
  $("visor-alerta").hidden = true;
  $("estado").textContent = "Cámara apagada";
  for (const id of ["btn-calibrar", "btn-sonido", "btn-detener"]) $(id).disabled = true;
  for (const li of $("alertas").children) { li.className = ""; li.lastElementChild.textContent = "—"; }
  for (const id of ["m-dist", "m-cuello", "m-hombros", "m-brillo"]) $(id).textContent = "—";
  enviarAlerta(null);
}
$("btn-detener").addEventListener("click", detener);
$("btn-calibrar").addEventListener("click", iniciarCalibracion);
$("btn-sonido").addEventListener("click", () => {
  sonido = !sonido;
  $("btn-sonido").textContent = sonido ? "Silenciar" : "Activar sonido";
  $("btn-sonido").setAttribute("aria-pressed", sonido);
});

function iniciarCalibracion() { calibracion = { muestras: [], inicio: null }; }

function pasoCalibracion(m, t) {
  const listo = m.rostro && m.cuerpo;
  if (listo) { calibracion.inicio ??= t; calibracion.muestras.push(m); }
  const pasado = calibracion.inicio === null ? 0 : t - calibracion.inicio;
  if (pasado < 5) {
    $("estado").textContent = calibracion.inicio === null
      ? "Aún no veo tu rostro y tus hombros. Aléjate un poco."
      : `Calibrando: quédate derecho ${Math.ceil(5 - pasado)} s`;
    return;
  }
  if (calibracion.muestras.length < 10) { iniciarCalibracion(); return; } // se movio: reintentar
  const d = Math.min(120, Math.max(30, Number($("distancia").value) || 60));
  cal = calibrar(calibracion.muestras, d);
  guardarCal(cal);
  gestor = new GestorAlertas(cal);
  calibracion = null;
  $("estado").textContent = "Calibración lista. Vigilando.";
}

function brilloMedio() {
  mctx.drawImage(video, 0, 0, mini.width, mini.height);
  const d = mctx.getImageData(0, 0, mini.width, mini.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}

const num = (v, dec, u) => (Number.isNaN(v) ? "—" : v.toFixed(dec).replace(".", ",") + u);

function ciclo() {
  if (!flujo || video.readyState < 2) return;
  const w = lienzo.width, h = lienzo.height;
  ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);   // efecto espejo, como en el prototipo
  ctx.drawImage(video, 0, 0, w, h); ctx.restore();
  const ts = Math.max(performance.now(), ultimoTs + 1);
  ultimoTs = ts;
  const rr = rostro.detectForVideo(lienzo, ts), rp = pose.detectForVideo(lienzo, ts);
  const t = ts / 1000;
  const m = medir(rr, rp, w, h, brilloMedio(), calibracion ? null : cal);

  if (rr.faceLandmarks?.[0]) {
    for (const l of [Vision.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, Vision.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE]) {
      dibujo.drawConnectors(rr.faceLandmarks[0], l, { color: "#ffc93c", lineWidth: 2 });
    }
  }
  if (m.cuerpo) {
    const p = rp.landmarks[0];
    ctx.strokeStyle = "#2fb573"; ctx.lineWidth = 5; ctx.lineCap = "round";
    for (const [a, b] of [[11, 12], [7, 11], [8, 12]]) {
      ctx.beginPath(); ctx.moveTo(p[a].x * w, p[a].y * h); ctx.lineTo(p[b].x * w, p[b].y * h); ctx.stroke();
    }
  }

  $("m-dist").textContent = num(m.distancia_cm, 0, " cm");
  $("m-cuello").textContent = num(cal?.cuello ? 100 * m.cuello / cal.cuello : NaN, 0, " % del tuyo");
  $("m-hombros").textContent = num(m.inclinacion_hombros, 0, "°");
  $("m-brillo").textContent = num(m.brillo, 0, " / 255");

  if (calibracion) {
    $("visor-alerta").hidden = true;
    pasoCalibracion(m, t);
    enviarAlerta(null);
    return;
  }
  const e = gestor.actualizar(m, datosArduino(), t);
  const principal = e.activas[0] ?? null;
  for (const li of $("alertas").children) {
    const k = li.dataset.alerta;
    const suena = e.activas.includes(k);
    li.className = suena ? "suena" : e.cond[k] ? "atento" : "ok";
    li.lastElementChild.textContent = suena ? "Sonando" : e.cond[k] ? "Atento" : "Bien";
  }
  const texto = principal ? MENSAJES[principal] + (principal === "postura" && e.motivo ? ` (${e.motivo})` : "") : "";
  if ($("visor-alerta").textContent !== texto) $("visor-alerta").textContent = texto;
  $("visor-alerta").hidden = !principal;
  const est = m.rostro ? "Vigilando" : m.cuerpo ? "Veo tu cuerpo, no tu rostro" : "No veo a nadie";
  if ($("estado").textContent !== est) $("estado").textContent = est;
  sonar(principal);
  enviarAlerta(principal);
}

// El reloj vive en un Worker para que siga aunque la pestana no este al frente.
const reloj = new Worker(URL.createObjectURL(new Blob([
  "let i;onmessage=e=>{clearInterval(i);if(e.data==='iniciar')i=setInterval(()=>postMessage(0),80)}",
], { type: "text/javascript" })));
let ocupado = false;
reloj.onmessage = () => {
  if (ocupado) return;
  ocupado = true;
  try { ciclo(); } catch (e) {
    console.error(e);
    detener();
    $("visor-texto").textContent = "El análisis se detuvo por un error. Vuelve a encender la cámara.";
  }
  setTimeout(() => { ocupado = false; }, 0);       // descarta ticks acumulados
};

// ---------- Arduino por USB (Web Serial: Chrome o Edge de escritorio) ----------
let puerto = null, escritor = null, lector = null, datos = null, tDatos = 0, codigo = 0, tEnvio = 0;
let cerrando = false;
function datosArduino() { return datos && performance.now() - tDatos <= 3000 ? datos : null; }
function enviarAlerta(alerta) {
  const c = alerta ? CODIGO[alerta] : 0, ahora = performance.now();
  if (!escritor || (c === codigo && ahora - tEnvio < 1000)) return;
  codigo = c; tEnvio = ahora;
  escritor.write(new TextEncoder().encode(`A${c}\n`)).catch(() => {});
}
function mostrarArduino(texto) {
  $("ard-estado").textContent = texto;
  $("btn-arduino").textContent = puerto ? "Desconectar Arduino" : "Conectar Arduino";
}
async function leerArduino() {
  let resto = "";
  const dec = new TextDecoder();
  while (!cerrando && puerto?.readable) {
    lector = puerto.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        resto += dec.decode(value, { stream: true });
        const lineas = resto.split("\n");
        resto = lineas.pop().slice(-200);
        for (const l of lineas) {
          const d = parsearTrama(l);
          if (!d) continue;
          datos = d; tDatos = performance.now();
          $("a-dist").textContent = d.distancia_cm >= 999 ? "Sin eco" : num(d.distancia_cm, 0, " cm");
          $("a-luz").textContent = String(d.luz);
          $("a-temp").textContent = num(d.temp_c, 1, " °C");
          $("a-hum").textContent = num(d.hum_pct, 0, " %");
          $("a-ses").textContent = `${d.min_sesion} min`;
          mostrarArduino("Conectado. Recibiendo datos cada segundo.");
        }
      }
    } catch { /* error de linea: si el puerto sigue legible, se reintenta */ } finally { lector.releaseLock(); }
  }
  try { escritor?.releaseLock(); await puerto?.close(); } catch { /* ya cerrado */ }
  puerto = escritor = lector = datos = null;
  for (const id of ["a-dist", "a-luz", "a-temp", "a-hum", "a-ses"]) $(id).textContent = "—";
  mostrarArduino(cerrando ? "Arduino desconectado." : "Se perdió la conexión. Revisa el cable y conéctalo de nuevo.");
  cerrando = false;
}
if (!("serial" in navigator)) {
  $("btn-arduino").disabled = true;
  mostrarArduino("Este navegador no puede usar el puerto USB. Abre la página en Chrome o Edge en una computadora.");
}
$("btn-arduino").addEventListener("click", async () => {
  if (puerto) {
    cerrando = true;
    try { await escritor.write(new TextEncoder().encode("A0\n")); } catch { /* sin cable */ }
    lector?.cancel().catch(() => {});
    return;
  }
  let p;
  try {
    p = await navigator.serial.requestPort();
    await p.open({ baudRate: 9600 });
  } catch (e) {
    mostrarArduino(e.name === "NotFoundError" ? "No elegiste ningún puerto."
      : "No se pudo abrir el puerto. Cierra el Arduino IDE y el programa de Python, y vuelve a intentar.");
    return;
  }
  puerto = p; escritor = p.writable.getWriter(); codigo = 0; tEnvio = 0;
  mostrarArduino("Conectado. Esperando la primera lectura…");
  leerArduino();
});
