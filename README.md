# OvoScan

Herramienta web para revisar huevos con la cámara: un modelo YOLO11 los localiza en la imagen y marca cada uno como **bueno** o **roto**, con su nivel de confianza, mientras la cámara sigue en vivo.

Trabajo de Ciencia de Datos, 6.º semestre.

## En resumen

| Pieza | Qué es |
| ----- | ------ |
| `backend/` | API en FastAPI que carga el modelo y sirve también la web ya compilada |
| `web/` | Interfaz en React + Vite que usa la cámara del navegador |
| Servidor | Una instancia EC2 con Debian, dos servicios systemd y un certificado autofirmado |

Acceso actual:

- Web (con cámara): `https://35.174.238.34:8443`
- API (HTTP): `http://35.174.238.34:8080`

## Flujo de una detección

```
cámara ──► frame JPEG ──► POST /classify ──► YOLO11 ──► JSON ──► recuadros sobre el video
         (cada ~1.2 s)
```

La web captura un frame, lo manda al servidor y pinta lo que vuelve. Los huevos que dejan de detectarse un instante no desaparecen de golpe: se mantienen en pantalla unos 2.5 s para evitar parpadeos.

### Respuesta de `/classify`

```json
{
  "eggs": [
    { "label": "bueno", "confidence": 0.87, "box": [0.12, 0.30, 0.45, 0.71] },
    { "label": "roto",  "confidence": 0.64, "box": [0.55, 0.28, 0.83, 0.69] }
  ],
  "count": 2
}
```

`box` son las esquinas `[x1, y1, x2, y2]` en proporción (0 a 1) del tamaño de la imagen, así que la web las adapta a cualquier pantalla.

## Archivos

```
backend/
  app/main.py          endpoints y carga del modelo
  model/best.pt        pesos entrenados (bueno, roto)
  requirements.txt
  deploy/              script de despliegue y unidades systemd
web/
  src/App.jsx          interfaz y seguimiento de detecciones
  src/config.js        URL de la API y parámetros de captura
  src/index.css        estilos
huevos.pem             llave SSH (ignorada por git)
```

## Probarlo en tu equipo

API:

```bash
cd backend
python3 -m venv venv
./venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
./venv/bin/pip install -r requirements.txt
./venv/bin/uvicorn app.main:app --reload --port 8080
```

Web:

```bash
cd web
npm install
npm run dev
```

Con `npm run dev` la web queda en `http://localhost:5173` y envía las imágenes al servidor desplegado (`web/src/config.js`). Con `npm run build` se genera `web/dist/`, que el backend sirve en `/`.

La cámara solo se habilita en `localhost` o bajo HTTPS; por eso en producción se entra por el puerto 8443.

## Endpoints

- `GET /health` devuelve `{"status": "ok"}`.
- `POST /classify` espera la imagen en el campo `image` (form-data).

Ajustes del modelo en `backend/app/main.py`:

- NMS agnóstico a la clase, para que un huevo no tenga a la vez una caja "bueno" y otra "roto".
- Corrección de orientación EXIF, necesaria con fotos tomadas desde iPhone.
- Se analiza el cuadro completo, de modo que se detectan varios huevos en cualquier zona.

## Publicar en el servidor

Un solo comando compila la web, sube todo y reinicia los servicios:

```bash
bash backend/deploy/deploy.sh
```

Si la llave no está en la raíz del proyecto, indica su ruta con `KEY=/ruta/huevos.pem bash backend/deploy/deploy.sh`.

El script deja corriendo, en `/home/admin/ovoscan-api`, estos servicios (se inician solos al reiniciar la máquina):

| Servicio | Puerto | Uso |
| -------- | ------ | --- |
| `ovoscan-api` | 8080 | API por HTTP |
| `ovoscan-api-tls` | 8443 | Web y API por HTTPS |

Requisitos en AWS: abrir los puertos 22, 8080 y 8443 en el Security Group.

El certificado es autofirmado, así que la primera vez el navegador avisa; basta con elegir "Avanzado" y continuar.

## Si algo falla

- **La web ya no abre después de apagar la instancia**: probablemente cambió la IP pública (sin Elastic IP pasa). Actualiza la IP en `web/src/config.js` y `backend/deploy/deploy.sh`, y vuelve a publicar.
- **No aparece la cámara**: entra por `https://` y acepta el permiso del navegador.
- **Los recuadros saltan o titilan**: revisa `mergeDetections` en `web/src/App.jsx`, que controla cuánto tiempo se conserva cada detección.
- **El servicio no arranca**: mira los registros con `sudo journalctl -u ovoscan-api -n 50`.
