# Dermalysse Webhook Server — Deploy en Railway

## Qué hace este servidor
- Crea sesiones de Stripe Checkout (para que los usuarios paguen)
- Recibe webhooks de Stripe (pago exitoso, cancelación, renovación)
- Actualiza Firestore automáticamente con el estado de la suscripción
- Crea sesiones del portal de Stripe (para que los usuarios gestionen/cancelen)
- Autoriza la reproducción protegida de clases desde Bunny Stream

---

## Paso 1: Subir a GitHub
1. Crear un nuevo repositorio en GitHub (ej: `dermalysse-webhook`)
2. Subir los archivos `index.js` y `package.json`

## Paso 2: Deploy en Railway
1. Ir a [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub"
3. Seleccionar el repositorio que creaste
4. Railway detectará Node.js automáticamente

## Paso 3: Configurar variables de entorno
En Railway → tu proyecto → Variables, agregar:

```
STRIPE_SECRET_KEY = sk_test_...

STRIPE_WEBHOOK_SECRET = (se obtiene en el Paso 4)

FIREBASE_SERVICE_ACCOUNT = (se obtiene en el Paso 5)

BUNNY_STREAM_LIBRARY_ID = (ID numérico de la biblioteca Membresia-Dermalyssee)

BUNNY_STREAM_TOKEN_KEY = (Token authentication key de Security; no la Stream API Key)

BUNNY_TOKEN_TTL_SECONDS = 300
```

La clave privada de Bunny nunca se coloca en el HTML. El navegador obtiene un
enlace temporal después de que Railway valida la sesión de Firebase y la
membresía activa o la cortesía vigente.

## Paso 4: Configurar Webhook en Stripe
1. Ir a Stripe Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. URL: `https://TU-APP.railway.app/webhook` (la URL que Railway te da)
4. Eventos a escuchar:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Click "Add endpoint"
6. Copiar el "Signing secret" (empieza con `whsec_`)
7. Pegar como `STRIPE_WEBHOOK_SECRET` en Railway

## Paso 5: Firebase Service Account
1. Ir a Firebase Console → ⚙️ Configuración del proyecto → Cuentas de servicio
2. Click "Generar nueva clave privada"
3. Se descarga un archivo JSON
4. Copiar TODO el contenido del JSON
5. Pegar como valor de `FIREBASE_SERVICE_ACCOUNT` en Railway (en una sola línea)

## Paso 6: Actualizar la URL en el Club
Una vez que Railway te dé la URL (ej: `https://dermalysse-webhook-production.up.railway.app`):
1. Abrir `index.html` del Club
2. Buscar: `const WEBHOOK_SERVER = '';`
3. Reemplazar por: `const WEBHOOK_SERVER = 'https://TU-URL.railway.app';`
4. Subir a GitHub

---

## Probar
1. Abrir el Club → ir a "Mi Suscripción"
2. Click "Suscribirme mensual" o "Suscribirme anual"
3. Usar tarjeta de prueba: `4242 4242 4242 4242` (cualquier fecha futura, cualquier CVC)
4. Debe regresar al Club con pantalla de gracias + confeti
5. Verificar en Firestore que el usuario tiene `subscription.status: 'active'`

## Pasar a producción
Cuando todo funcione:
1. En Railway: cambiar `STRIPE_SECRET_KEY` a `sk_live_...`
2. En Stripe: crear webhook apuntando a la misma URL pero en modo Live
3. Actualizar `STRIPE_WEBHOOK_SECRET` con el nuevo signing secret
4. En el Club: cambiar `STRIPE_PK` a `pk_live_...`
5. Crear los mismos productos/precios en Stripe Live y actualizar los Price IDs
