# Plan de upgrade: eve 1.0.0-rc.10 → 1.0.2

- **Estado actual:** `eve@1.0.0-rc.10`
- **Objetivo:** `eve@1.0.2` (1.0.0 + dos patches: 1.0.1 y 1.0.2)
- **Rama:** `upgrade/eve-1.0`
- **Fecha:** 2026-11-17

## Resumen

nook ya hizo la migración grande a la API 1.0 durante las rc (sandbox `DockerSandbox.environment`,
`defineDynamic`, session events v27, approvals con `approval.prompt`). Entre rc.10 y 1.0.2 **no hay
breaking changes que afecten código de nook**: typecheck, lint y tests pasan sin tocar nada.
Lo que queda es ajustar auditoría y comportamiento al nuevo tool `edit_file` y al nuevo formato
de `bash`, verificar el build con Docker y hacer un smoke test en Telegram.

## Fase 0 — Bump de dependencias ✅ (hecho en la rama)

| Paquete | Antes | Después |
| --- | --- | --- |
| `eve` | `1.0.0-rc.10` | `1.0.2` (pin exacto, como antes) |
| `ai` | `^7.0.170` | `^7.0.175` (eve exige ≥ 7.0.172) |
| `@ai-sdk/openai-compatible` | `^3.0.90` | `^3.0.93` |

Resultado: `npm run typecheck` ✅ · `npm run lint` ✅ · `npm test` ✅.
`eve build` ✅ con el Docker rootless (`DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock`).

## Fase 1 — Build y template del sandbox ✅

1. Levantar Docker y correr `npx eve build`.
2. Verificar que el template `root` se prepara (apt-get `hledger jq curl`).
3. Si falla con `resolves outside package root`: alguna importación de assets sale del paquete
   (1.0 lo valida en todos los imports, no sólo `?raw`). Hoy no hay ninguna, no debería pasar.

## Fase 2 — `edit_file`: nuevo tool por defecto (breaking de 1.0.0) ✅

Todo agente recibe `edit_file` (`{ path, edits: [{ oldText, newText }] }`). Para nook es
**bueno** (ediciones puntuales en journals en vez de reescribir con `write_file`), pero:

- `agent/lib/audit-fields.ts` no lo conoce: cae en `default` (sólo `argKeys`/`argBytes`).
  No filtra contenido, pero se pierde el `path`. Agregar:
  - input → `{ path, editCount, oldBytes, newBytes }` (nunca el texto).
  - output → `{ path, replacements }` (eso es lo que llega en `call.settled`).
- Agregar test en `audit-fields.test.ts` ("never copies edit_file text").
- Decidir si se mantiene. Recomendado: **sí**. Para quitarlo: `agent/tools/edit_file.ts`
  exportando `disableTool()`.

## Fase 3 — `bash`: salida en texto plano y exit ≠ 0 como error ✅

- El modelo ahora ve stdout, `[stderr]` y `[exit code: N]` en texto, no JSON.
  `call.settled` conserva los campos estructurados, así que `summarizeToolOutput("bash")`
  sigue funcionando. Verificar en el smoke test que `exitCode`/`stdoutBytes` siguen llenos.
- Un comando con exit ≠ 0 llega al modelo **como error**. `hledger check` / `git rebase` con
  conflicto ahora se ven como fallos de tool. Revisar que el prompt (`instructions.md`, skill
  `hledger-entry`) no dependa de "leer el exitCode del JSON".
- Timeout por defecto: el modelo puede pasar `timeout` (hasta 120 s). Sin cambios necesarios.
- El truncado ahora indica un archivo en el sandbox con la salida completa.

## Fase 4 — Riesgos de deploy (self-hosted Docker)

- **Rollback:** los checkpoints pasan a versión 19. Un deploy rc.10 no toma sesiones escritas por
  1.0.x: tras volver atrás, esas sesiones quedan varadas. Antes de deployar, aceptar que el
  rollback implica sesiones nuevas.
- **Turnos fallidos:** ahora cierran con `TURN_FAILED` y un mensaje fijo + error id (sin el
  mensaje crudo). Los logs de `audit.ts` vía `errorFields` van a tener menos detalle; usar el
  error id para correlacionar con el log de Workflow.
- **Un solo proceso por `.eve/.workflow-data`:** la recuperación asume que los steps previos al
  boot están abandonados. Ya es así con el volumen actual; no correr dos contenedores sobre el
  mismo volumen.
- **Node:** eve apunta a Node 26 pero soporta ≥ 24. Mantener `24.x` en `engines` y en el
  Dockerfile por ahora (opcional: pasar a `node:26-slim` + `@types/node@26.x` en un cambio aparte).

### Hecho en fases 2–3 (+ manejo de errores)

- `audit-fields.ts`: `edit_file` (input: `path`, `editCount`, `oldBytes`, `newBytes`; output:
  `path`, `replacements`) y `status` de `bash` (`completed`/`running`). Tests de no-filtrado.
- `push`/`pull`: `toModelOutput: ledgerModelOutput`. Éxitos → JSON; `conflict`, `push_failed`,
  `pull_failed`, `blocked` → `error-text` con el outcome + próximo paso. `call.settled` y la
  auditoría siguen recibiendo el output estructurado.
- `update_prices`: `fetchJsonWithRetry` (3 intentos, timeout 8 s, backoff, respeta
  `ctx.abortSignal`, no reintenta 4xx). Sólo para GETs idempotentes.
- Prompt y skill: usar `edit_file` sobre journals (sólo entradas sin commitear o conflictos) y
  cómo leer los errores de `bash`/`push`/`pull`.

## Fase 5 — Smoke test (Telegram) ⏳ pendiente (necesita `.env` con API key y usuarios)

1. Saludo sin herramientas → no debería levantar el sandbox (1.0 ya no lo despierta en turnos
   que no lo usan).
2. Registrar una compra → `edit_file` o `write_file` sobre el journal, commit local, card de push.
3. Aprobar push → la card ahora se edita como "Approved by <nombre>".
4. Comprobante adjunto (imagen/PDF).
5. `npm run eval` (evals actuales: greeting, missing-amount, receipt, sin-cta).

## Fase 6 — Commit y deploy

- `chore(deps): upgrade eve to 1.0.2`
- `feat(audit): summarize edit_file calls`
- Deploy según README (build en el host).

---

# Features nuevas útiles para nook

Ordenadas por valor/esfuerzo.

## Gratis con el upgrade

- **Compaction más robusta:** una sola compactación por sesión larga y la sesión ya no muere
  si se pasa del umbral o de la ventana (sólo falla el turno). Relevante porque nook declara
  la ventana a mano (`NOOK_MODEL_CONTEXT_TOKENS`).
- **Reintentos ante `AI_TypeValidationError`:** chunks mal formados del proveedor
  OpenAI-compatible (OpenCode Go) ahora se reintentan en vez de fallar el turno.
- **Sandbox perezoso:** un turno que no usa el sandbox no lo despierta (menos clones de repo).
- **Self-hosted:** `eve start` sale rápido con SIGTERM y cierra el Workflow world; arreglados
  timers (`sleep`) y steps que quedaban colgados ~14 min tras un restart del contenedor.
- **Steering:** un mensaje nuevo mientras el modelo escribe un tool call ya no lo descarta.
- **Telegram:** las cards de approval dicen quién aprobó.
- **Sesiones guardan mucho menos estado** por step (diffs immer) → el volumen crece más lento.

## Para adoptar (recomendado)

1. **`toolOutput.errorText()` en `push`/`pull`** (`eve/tools`): devolver `conflict` /
   `push_failed` / `blocked` como error para el modelo, manteniendo el output estructurado en
   `call.settled` (la auditoría no cambia). El modelo reacciona mejor a un error explícito.
2. **Schedules fijos con `timezone`** (`defineSchedule({ timezone: "America/Argentina/Buenos_Aires" })`):
   p. ej. `update_prices` diario o un resumen semanal de gastos por usuario. Soportado en
   servidores Node self-hosted.
3. **`approval` a nivel `agent.ts`:** una política global que corre junto a la de cada tool y
   gana la más estricta. Útil como defensa en profundidad: exigir aprobación para cualquier
   tool que toque red además de `push`, sin depender de que cada tool la declare.
4. **`ctx.conversation.space` (Telegram):** expone `type: direct|shared`. Puede reemplazar el
   chequeo manual de `chat.type !== "private"` en hooks/tools que necesiten saber el contexto
   (el filtro del canal se queda).

## Para evaluar más adelante

- **Custom skills (experimental)** `eve/experimental/extensions/custom-skills`: que cada usuario
  guarde sus propias reglas de categorización como skills versionadas, con approval. Necesita un
  backend `eve/memory/file` (por defecto Vercel Blob; habría que usar uno local).
- **`label: false`** en tools: ocultar llamadas de la actividad del canal (p. ej. `pull`), si el
  indicador de "typing" molesta.
- **`createStreamChecker`** (`eve/events`): validar streams guardados en `.workflow-data` en un
  script de diagnóstico.
- **Canal A2A** (`eve/channels/a2a`): exponer nook a otros agentes. Sin caso de uso hoy.
