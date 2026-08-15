# Backend del Club Dermalysse

Servicio Express para webhooks y operaciones de Stripe, consulta de membresía y reproducción temporal protegida desde Bunny Stream.

## Funciones

- Crea sesiones de Stripe Checkout y del portal de clientes.
- Procesa webhooks de pagos, renovaciones y cancelaciones.
- Actualiza la membresía en Firestore.
- Verifica Firebase ID tokens en todas las rutas sensibles.
- Autoriza vistas previas gratuitas y clases premium de Bunny Stream.

## Configuración

Configura las variables descritas en `.env.example` directamente en Railway o en un archivo `.env` local. Nunca agregues valores reales al repositorio.

Variables principales:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `FIREBASE_SERVICE_ACCOUNT`
- `BUNNY_STREAM_LIBRARY_ID`
- `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_STREAM_TOKEN_AUTH_KEY` o la clave compatible configurada para la biblioteca
- `BUNNY_STREAM_TOKEN_TTL_SECONDS`

Las variables de EmailJS son opcionales. Si no existen, las notificaciones por correo se omiten sin afectar pagos ni reproducción.

## Ejecución local

```bash
npm install
npm start
```

## Webhook de Stripe

Configura en Stripe el endpoint desplegado terminado en `/webhook` y guarda su signing secret únicamente como `STRIPE_WEBHOOK_SECRET` en Railway.

## Reproducción Bunny

El Club solicita `POST /bunny/playback` con un Firebase ID token y los identificadores internos de curso y clase. El servidor valida que el recurso pertenezca al catálogo y genera un embed firmado de corta duración.

Una clase marcada `isPreview: true` está disponible para cualquier usuario registrado. Las demás requieren membresía vigente o cortesía vigente. El endpoint anterior `/api/bunny/embed-token` se conserva temporalmente para compatibilidad durante la actualización del frontend.

El catálogo local de respaldo está en `data/dermalysse-courses.json` y no contiene credenciales ni URLs premium estables.

## Seguridad operativa

- Revoca cualquier credencial que haya estado expuesta previamente.
- Mantén `.env` fuera de Git.
- Las rutas de checkout, cancelación, reactivación, portal y consulta usan el UID verificado del token; no confían en un UID enviado por el navegador.
- CORS se limita al dominio del Club y a los orígenes locales de desarrollo.
