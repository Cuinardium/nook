# Plan de upgrade: eve 0.45.2 → 0.82.0

- **Estado actual:** `eve@0.45.2`
- **Objetivo:** `eve@0.82.0`
- **Rama propuesta:** `upgrade/eve-0.82`
- **Fecha:** 2026-10-21

## Objetivos

1. Adaptar nook a la última versión de eve sin cambiar su comportamiento de negocio.
2. Eliminar `ask_question` del agente y de las evals: las preguntas pasan a ser texto plano.
3. Simplificar la aprobación de `push` usando `approval.prompt`.
4. Dejar el proyecto compilando, con tests, lint y build verdes.
5. Preparar el terreno para recibir comprobantes como adjuntos (fase posterior).

## Fuera de alcance

- Cambiar el modelo o el proveedor de OpenCode Go.
- Agregar subagentes, conexiones MCP o schedules.
- Cambiar el flujo de negocio de hledger.
- Implementar adjuntos en esta misma rama.

## Referencias

- Skill `eve` instalada en `.agents/skills/eve`.
- Docs de `eve@0.82.0` descomprimidas fuera del repo para consulta.
- Changelog completo de eve entre `0.45.2` y `0.82.0`.

---

# Fase 0 — Baseline y rama

- Crear la rama `upgrade/eve-0.82`.
- Ejecutar `npm install` (hoy no hay `node_modules`).
- Registrar el baseline antes de tocar versiones:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npx eve build`
- Anotar las fallas preexistentes para no atribuirlas al upgrade.

**Criterio de aceptación:** existe un baseline reproducible y se conocen sus fallas.

---

# Fase 1 — Dependencias

Actualizar en `package.json`:

| Paquete | Actual | Objetivo |
| --- | --- | --- |
| `eve` | `^0.45.2` | `^0.82.0` |
| `ai` | `^7.0.58` | `^7.0.148` |
| `@ai-sdk/openai-compatible` | `^3.0.36` | `^3.0.75` |
| `zod` | `4.4.3` | `^4.6.7` |

Opcional, sin relación directa con el upgrade:

- `@biomejs/biome` a `^2.6.2`.
- Revisar si `@vercel/connect@0.4.3` se usa; si no, evaluar quitarlo en un cambio aparte.

Pasos:

1. Editar `package.json`.
2. `npm install`.
3. Correr `npm run typecheck` para descubrir los breaking changes reales.

**Criterio de aceptación:** las dependencias instalan y solo fallan los cambios de API esperados.

---

# Fase 2 — Sandbox

El cambio más grande. En 0.64 se eliminó el `defineSandbox({ backend, bootstrap, onSession })`.

## Estado actual

`agent/sandbox/sandbox.ts` usa:

- `docker({ env })`
- `revalidationKey`
- `bootstrap({ use })` para instalar `hledger`, `jq` y `curl`
- `onSession({ use, ctx })` para clonar el ledger por usuario, configurar git, crear `precios/` y hacer el readiness check

## Estado objetivo

```ts
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.environment({
  env: {
    TZ: process.env.NOOK_TIMEZONE ?? "America/Argentina/Buenos_Aires",
    LC_ALL: "C.UTF-8",
  },
  async prepare(sandbox) {
    // apt-get install hledger jq curl + verificación de versiones
  },
});

export default defineSandbox(async ({ session }) => {
  const sandbox = await environment.open();

  // Resolver principal desde session.auth.current.
  // Clonar el repo con withForgeCredentials.
  // Configurar git user.name / user.email.
  // Crear precios/dolares.journal y stocks.journal.
  // Readiness check (git log + journals).
  // Log de sandbox listo.

  return sandbox;
});
```

Cambios concretos:

- Borrar `revalidationKey`; el template se invalida por el contenido de `prepare`.
- Mover la instalación de paquetes a `prepare`.
- Mantener el clone y la configuración por usuario en el selector de `defineSandbox`.
- Mantener el fail-closed cuando no hay principal o el usuario no está registrado.
- Mantener `withForgeCredentials` y el log de readiness.

## Riesgos a validar

1. **Timezone:** `env` ahora se define al preparar el template, no por request. Confirmar que `NOOK_TIMEZONE` esté disponible en build; si no, fijar el valor o aplicar TZ por comando.
2. **Sandbox persistente:** el sandbox es por sesión. El clone corre una vez; los cambios remotos posteriores se traen con `pull`.
3. **Red en `prepare`:** `apt-get` necesita red. No aplicar `networkPolicy: "deny-all"` al sandbox de nook.
4. **Prewarm del template:** en 0.82 `eve build` prepara los artefactos del sandbox. Nuestro `Dockerfile` compila en una etapa sin daemon de Docker ni CLI, así que el build puede fallar. Hay que decidir una estrategia:
   - Montar `/var/run/docker.sock` durante el build con BuildKit e incluir el CLI de Docker en la etapa builder.
   - Compilar en el host (con daemon disponible) y copiar `.output/` y el cache de sandbox a la imagen.
   - Mover la preparación al arranque del contenedor, que sí tiene acceso al socket.
   - No usar `--skip-sandbox-prewarm` para producir la imagen final: la propia doc advierte que ese output puede no ser desplegable.
5. **Persistencia de workflows:** montar `.eve/.workflow-data` en almacenamiento persistente para que las sesiones sobrevivan a reinicios del contenedor.

**Criterio de aceptación:**

- `npx eve build` completa.
- Una sesión real clona el ledger y ejecuta `hledger`.
- La imagen Docker arranca con el template de sandbox disponible.

---

# Fase 3 — Eliminar `ask_question`

En 0.65 `ask_question` dejó de ser una tool default. Nook no la quiere, así que no se agrega.

## Cambios

- `agent/instructions.md:27`: reemplazar “preguntá con `ask_question`” por una regla de pregunta en texto plano, por ejemplo:
  > Si falta información esencial, preguntá en tu respuesta y esperá la respuesta del usuario. No asumas.
- `evals/missing-amount-asks.eval.ts`: quitar `t.requireInputRequest` y `t.respond`; enviar el mensaje y verificar que la respuesta pide el monto.
- `evals/sin-cta.eval.ts`: mismo cambio; el escenario pasa a ser “pide el monto en texto y no cierra con una llamada a la acción”.
- Verificar que no queden referencias a:
  - `ask_question`
  - `askQuestion`
  - `requireInputRequest`
  - `t.respond`

## Consecuencia de comportamiento

Sin `ask_question` el turno no queda “parkeado” esperando un botón o un `ForceReply`. El agente termina su respuesta con una pregunta y el usuario contesta con un mensaje normal, que continúa la misma sesión. Es el comportamiento deseado.

**Criterio de aceptación:**

- `grep` sin referencias a `ask_question`.
- Evals actualizadas y verdes.
- Prueba manual: “pagué el súper” → Nook pregunta el monto en texto.

---

# Fase 4 — Aprobación de `push` con `approval.prompt`

## Cambios

En `agent/tools/push.ts`, reemplazar:

```ts
approval: always(),
```

por:

```ts
approval: {
  request: always(),
  prompt: () => "Confirmar push\n\nPusheo los commits pendientes al remoto.",
},
```

En `agent/channels/telegram.ts`:

- Eliminar el caso especial `isPushApproval`.
- Eliminar `approvalCardId` y la limpieza manual del teclado en `action.result`.
- Eliminar `HtmlBody`, `htmlPost` y el `parse_mode` si no se usan en otro lado.
- Seguir usando `renderTelegramInputRequest` para obtener `text` y `replyMarkup`.

En `agent/lib/cards.ts` y `agent/lib/cards.test.ts`:

- Borrar ambos archivos, o mover el test del texto del prompt a `agent/tools/push.test.ts` si se quiere conservar la intención.

Mantener:

- El keep-alive de “typing” mientras corre una tool.
- El stop del keep-alive en `action.result`, `message.completed`, `turn.failed` y `session.failed`.

**Criterio de aceptación:**

- La tarjeta de push se ve igual o mejor.
- Los botones se limpian solos al responder.
- No queda código HTML específico para la tarjeta.

---

# Fase 5 — Ajustes por breaking changes

- **`turn.failed`:** ahora incluye `terminal`. Si `terminal === true`, no mandar el mensaje genérico para no duplicar el aviso con `session.failed`.
- **Skills:** `load_skill` pasó a `eve__skill`. No tenemos overrides; verificar que `hledger-entry` carga bien.
- **Hooks:** `action.result` sigue existiendo. Validar `event.data.status` y el `toolName`.
- **Auth del owner:** probar si después de una aprobación por Telegram `ctx.session.auth.current` sobrevive. Si sobrevive, evaluar borrar:
  - `agent/hooks/owner.ts`
  - `agent/lib/owner.ts`
  - Los fallbacks `sessionOwner.get()` en `push`, `pull` y `audit`.
  Este cleanup no bloquea el upgrade; se hace solo si la prueba manual confirma que ya no hace falta.
- **Web search:** `disableTool()` sigue válido. Mantener `agent/tools/web_search.ts`.

**Criterio de aceptación:** typecheck y tests limpios; sin mensajes de error duplicados.

---

# Fase 6 — Evals, tests y verificación

- Adaptar las evals a la API actual:
  - `t.send()` devuelve un turn con `.session`.
  - Los follow-ups se hacen con `turn.session.send(...)`.
- Correr:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npx eve build`
  - `npx eve eval` si hay credenciales disponibles.
- Prueba manual por Telegram:
  - Mensaje normal sin tools.
  - Pregunta de monto en texto.
  - `push` con aprobación y limpieza de botones.
  - `pull`.
  - `update_prices`.
  - Error de tool y mensaje de fallo.
  - Reinicio del contenedor y continuación de una sesión.

**Criterio de aceptación:** todos los comandos pasan y el flujo manual completo funciona.

---

# Fase 7 — Deploy

- Construir la imagen Docker con la estrategia de prewarm elegida en la Fase 2.
- Verificar que el contenedor arranca con el template de hledger disponible.
- Montar `.eve/.workflow-data` en almacenamiento persistente.
- Avisar que las sesiones viejas de 0.45 pueden quedar “stranded” en self-hosted:
  - El próximo mensaje por el canal arranca una sesión nueva.
  - No es una migración de datos; es esperado.
- Desplegar en un horario de bajo uso.
- Verificar el flujo completo por Telegram después del deploy.

**Criterio de aceptación:** deploy sano, sesiones nuevas funcionando y sin errores de sandbox.

---

# Fase posterior — Adjuntos entrantes

Asunción: “enviar archivos adjuntos” significa que **el usuario le manda comprobantes a Nook** (fotos o PDFs). Si además se quiere que Nook exporte y envíe archivos, se planifica aparte.

## A. Spike de capacidad del modelo

`deepseek-v4-flash` vía OpenCode Go puede no ser multimodal.

1. Mandar una foto JPEG y un PDF por Telegram.
2. Verificar si el modelo recibe los bytes o solo la etiqueta con el path del archivo.
3. Si no los entiende, activar el plan B con OCR.

**Decisión:** continuar con visión nativa u OCR.

## B. Configuración del canal

- Mantener el `uploadPolicy` actual:
  - `image/*`
  - `application/pdf`
  - máximo 10 MB
- Confirmar que fotos y documentos de Telegram llegan a `/workspace/.eve/attachments/...`.
- Evaluar aceptar HEIC como documento. Sin visión nativa, HEIC llegaría solo como etiqueta; si se necesita, agregar conversión.

## C. Instrucciones de negocio

Agregar a `agent/instructions.md`:

- Un adjunto con caption es un comprobante: extraer fecha, monto, moneda y comercio.
- Si hay varios comprobantes, proponer una entrada por cada uno.
- Si el monto o la fecha no se leen, preguntar en texto.
- No repetir números de tarjeta ni datos sensibles.
- No commitear automáticamente; aplican las reglas actuales.
- Usar `read_file` para reabrir el adjunto si hace falta después de una compactación.

## D. Plan B: OCR en el sandbox

Si el modelo no puede leer imágenes o PDFs escaneados:

- Agregar al `prepare` del sandbox:
  - `poppler-utils` para `pdftotext` y `pdftoppm`.
  - `tesseract-ocr` y `tesseract-ocr-spa` para imágenes.
- Crear `agent/tools/read_attachment.ts`:
  - Input: path del adjunto.
  - PDF digital: `pdftotext`.
  - Imagen o PDF escaneado: OCR.
  - Output: texto extraído.
- Actualizar las instrucciones para usar la tool antes de proponer el asiento.

Considerar el costo de imagen y tiempo de build antes de sumar Tesseract.

## E. Evals de adjuntos

- Fixture con un comprobante claro (preferentemente PDF digital con texto).
- Enviar con `session.send([{ type: "text", ... }, { type: "file", ... }])`.
- Assertar que la respuesta menciona:
  - monto
  - fecha
  - comercio
- Usar `t.check(turn.message, ...)` con matchers determinísticos o un judge si hace falta.
- Evitar depender de OCR en CI si el modelo ya lee imágenes.

## F. Pruebas manuales

- Foto JPEG de un ticket.
- PDF digital.
- PDF escaneado.
- Varios adjuntos en un mismo mensaje.
- Archivo no soportado.
- Archivo de más de 10 MB.
- Adjunto sin caption y con caption.

## G. Seguridad y privacidad

- No loguear el contenido de los comprobantes.
- No repetir números de tarjeta completos en las respuestas.
- Los archivos viven solo en el sandbox de la sesión.
- Revisar si el audit log debe incluir metadata del adjunto o nada.

## Criterio de aceptación de adjuntos

- El usuario manda una foto o PDF y Nook propone el asiento correcto.
- Si no puede leerlo, lo dice y pide los datos que faltan.
- No se commitea nada automáticamente.
- El flujo no rompe sesiones existentes ni el presupuesto de contexto.

---

# Riesgos y decisiones abiertas

1. **Prewarm del sandbox en Docker:** es el mayor riesgo de deploy. Definir estrategia antes de la Fase 7.
2. **Modelo multimodal:** confirmar si `deepseek-v4-flash` acepta imágenes y PDFs antes de prometer adjuntos.
3. **Sesiones viejas:** en self-hosted no sobreviven al upgrade; documentarlo.
4. **`sessionOwner`:** eliminar solo después de verificar que las aprobaciones por Telegram conservan la auth.
5. **Timezone:** confirmar que `NOOK_TIMEZONE` se aplica correctamente en el template.
6. **Tamaño de imagen:** OCR y paquetes de idioma pueden aumentar mucho la imagen del sandbox.

---

# Definition of done

- [ ] `eve@0.82.0` instalado y lockfile actualizado.
- [ ] Sandbox migrado a `DockerSandbox.environment` + `prepare` + selector.
- [ ] `ask_question` eliminado de instrucciones, evals y código.
- [ ] `push` usa `approval.prompt`; el código especial de Telegram fue eliminado.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` y `npx eve build` pasan.
- [ ] Prueba manual completa por Telegram.
- [ ] Imagen Docker construida y desplegada con el sandbox prewarm funcionando.
- [ ] Plan de adjuntos revisado y decidido (visión nativa u OCR).
