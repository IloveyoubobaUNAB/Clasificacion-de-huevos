import { useEffect, useRef, useState } from 'react';
import { CLASSIFY_ENDPOINT, MAX_SCAN_WIDTH, SCAN_INTERVAL_MS } from './config';
import './index.css';

const COLORS = { good: '#3ddc97', bad: '#ff5d6c' };
const TRACK_GRACE_MS = 2500; // ~2 capturas: un huevo que no se detecta una vez no desaparece de golpe

function boxIou([ax1, ay1, ax2, ay2], [bx1, by1, bx2, by2]) {
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = ix * iy;
  const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
  return union > 0 ? inter / union : 0;
}

// Empareja las detecciones nuevas con las que ya veniamos mostrando (por
// solape de caja) y les da un tiempo de gracia antes de quitarlas, para que
// un solo frame fallido no las haga parpadear. Devuelve tambien cuales son
// huevos "nuevos" (no vistos antes) para poder acumular el total de la sesion.
function mergeDetections(tracked, detections, now) {
  const used = new Set();
  const added = [];
  const kept = tracked.map((t) => {
    let bestIdx = -1;
    let bestIou = 0.3;
    detections.forEach((d, i) => {
      if (used.has(i)) return;
      const v = boxIou(t.box, d.box);
      if (v > bestIou) {
        bestIou = v;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      used.add(bestIdx);
      return { ...detections[bestIdx], lastSeen: now };
    }
    return t;
  });

  detections.forEach((d, i) => {
    if (!used.has(i)) {
      const entry = { ...d, lastSeen: now };
      kept.push(entry);
      added.push(entry);
    }
  });

  return { merged: kept.filter((e) => now - e.lastSeen <= TRACK_GRACE_MS), added };
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
  const streamRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [camError, setCamError] = useState(null);
  const [aspect, setAspect] = useState(4 / 3); // alto/ancho; se recalibra al abrir la cámara
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [eggs, setEggs] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [session, setSession] = useState({ total: 0, good: 0, bad: 0 });

  // Pide la cámara una sola vez al montar.
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      // 720p/30fps: sin pedir nada el navegador suele dar 640x480, pero pedir
      // mas (p. ej. 1920x1440) hace que webcams USB como las Logitech caigan
      // a modos de pocos fps y el video se ve entrecortado.
      ?.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          setAspect(video.videoHeight / video.videoWidth);
          setReady(true);
        };
      })
      .catch((err) => setCamError(err.message || 'No se pudo acceder a la cámara'));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const scan = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    setBusy(true);
    try {
      const canvas = canvasRef.current;
      const ratio = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * ratio);
      canvas.height = Math.round(video.videoHeight * ratio);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));

      const form = new FormData();
      form.append('image', blob, 'huevo.jpg');

      const res = await fetch(CLASSIFY_ENDPOINT, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Servidor respondió ${res.status}`);
      const data = await res.json();
      setEggs((prev) => {
        const { merged, added } = mergeDetections(prev, data.eggs ?? [], Date.now());
        if (added.length > 0) {
          const addedGood = added.filter((e) => e.label === 'bueno').length;
          setSession((s) => ({
            total: s.total + added.length,
            good: s.good + addedGood,
            bad: s.bad + (added.length - addedGood),
          }));
        }
        return merged;
      });
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg('Sin conexión con el servidor, reintentando…');
    } finally {
      setBusy(false);
    }
  };

  // Escaneo continuo: captura, espera respuesta, agenda la siguiente.
  // Nunca hay dos peticiones en vuelo.
  useEffect(() => {
    if (!ready || paused) return undefined;
    let cancelled = false;
    let timer;

    const tick = async () => {
      if (cancelled) return;
      await scan();
      if (!cancelled) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready, paused]);

  const good = eggs.filter((e) => e.label === 'bueno').length;
  const bad = eggs.filter((e) => e.label === 'roto').length;

  let hint = 'Apunta la cámara a los huevos';
  if (camError) hint = 'No se pudo acceder a la cámara';
  else if (paused) hint = 'Escaneo en pausa';
  else if (errorMsg) hint = errorMsg;
  else if (busy) hint = 'Analizando…';

  const live = ready && !paused && !camError && !errorMsg;

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">
          OVO<span>SCAN</span>
        </h1>
        <span className={`status ${live ? 'on' : ''}`}>
          <i /> {live ? 'EN VIVO' : paused ? 'PAUSA' : 'SIN SEÑAL'}
        </span>
      </header>

      <main className="layout">
        <section className="scanner">
          <div className="video-frame" style={{ aspectRatio: `1 / ${aspect}` }}>
            <video ref={videoRef} autoPlay playsInline muted className="video" />
            <b className="corner tl" />
            <b className="corner tr" />
            <b className="corner bl" />
            <b className="corner br" />

            {camError && (
              <div className="cam-error">
                <p>{camError}</p>
                <p className="cam-error-hint">Habilita el acceso a la cámara en el navegador y recarga.</p>
              </div>
            )}

            {!paused &&
              eggs.map((egg, i) => {
                const color = egg.label === 'bueno' ? COLORS.good : COLORS.bad;
                const [x1, y1, x2, y2] = egg.box;
                return (
                  <div
                    key={i}
                    className="egg-box"
                    style={{
                      borderColor: color,
                      left: `${x1 * 100}%`,
                      top: `${y1 * 100}%`,
                      width: `${(x2 - x1) * 100}%`,
                      height: `${(y2 - y1) * 100}%`,
                    }}
                  >
                    <span className="egg-tag" style={{ background: color }}>
                      {egg.label} {Math.round(egg.confidence * 100)}%
                    </span>
                  </div>
                );
              })}
          </div>

          <div className="bar">
            <p className="hint">{hint}</p>
            <button className="pause-btn" onClick={() => setPaused((p) => !p)} disabled={!ready}>
              {paused ? 'Reanudar' : 'Pausar'}
            </button>
          </div>
        </section>

        <aside className="side">
          <div className="panel">
            <h2>Ahora en cámara</h2>
            <div className="big">{eggs.length}</div>
            <div className="split">
              <div className="good">
                <b>{good}</b> buenos
              </div>
              <div className="bad">
                <b>{bad}</b> rotos
              </div>
            </div>
            {eggs.length > 0 && (
              <ul className="egg-list">
                {eggs.map((egg, i) => (
                  <li key={i} className={egg.label === 'bueno' ? 'good' : 'bad'}>
                    <span>#{i + 1}</span>
                    <span>
                      {egg.label} · {Math.round(egg.confidence * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h2>Sesión</h2>
            <div className="session">
              <div>
                <b>{session.total}</b>
                <span>escaneados</span>
              </div>
              <div className="good">
                <b>{session.good}</b>
                <span>buenos</span>
              </div>
              <div className="bad">
                <b>{session.bad}</b>
                <span>rotos</span>
              </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="footer">OvoScan · YOLO11 · Proyecto de Ciencia de Datos</footer>
    </div>
  );
}
