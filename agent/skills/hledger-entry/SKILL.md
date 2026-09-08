---
description: Procedimiento paso a paso para registrar una compra, ingreso o ganancia en el journal de hledger y commitearlo con aprobación.
---

# Registrar una entrada

1. **Contexto**: `cd /workspace/ledger`. Corré `ls *.journal` para ver los
   archivos y `hledger accounts` para el plan de cuentas. Mirá las últimas 3-5
   transacciones (`hledger reg -p "last 7 days"`) para imitar el estilo de
   descripción y las cuentas usadas.

2. **Elegir archivo**: escribí en el journal raíz cuyo nombre contiene el año
   en curso (ej. `2026.journal`). Si no existe, crealo copiando el encabezado
   (`commodity ...`, `include precios/...`) de un año anterior si lo hay.

3. **Redactar la transacción**:
   - Formato hledger estándar, fecha `AAAA-MM-DD`.
   - Descripción corta en español, estilo de las existentes («Subte», «Bar gonza»).
   - Dos o más postings que sumen cero. Compra → débito a la cuenta de origen
     (`activos:bancos:bbva:ARS`, `activos:cash:*`). Ingreso/ganancia → crédito
     desde `ingresos:*` o `patrimonio:*`.
   - Activos/inversiones solo si el usuario pide explicitamente registrar una
     operación de cartera; usá lotes `{costo}` igual que las entradas previas.

4. **Validar**: appendear al journal y correr `hledger check` más
   `hledger bal -p "today"`. Si hay error, corregilo antes de seguir. Si el
   error es por precios faltantes (`include precios/`), llamá `update_prices`
   y reintentá.

5. **Proponer**: mostrale al usuario el bloque completo de la transacción tal
   cual quedó escrito, más una línea explicando la categoría elegida si hubo
   duda. Cerrá con la lista compacta de pendientes (`1. Cafe — $4.500`), sin
   repetir cuentas y sin ofrecerte a commitear: el usuario da la orden.

6. **Commitear y pushear**: cuando el usuario lo pide, commiteá localmente
   con git y llamá `push`. La tarjeta del bot pide la confirmación a ciegas;
   no preguntes vos.

7. **Según el `status` que devuelve**:
   - `pushed`: listo. No repitas el sha.
   - `clean`: no había nada pendiente; no es un error.
   - `conflict`: hay un rebase en curso. Abrí cada archivo de `files`, resolvé
     los marcadores a mano con git — conservá tus entradas nuevas y respetá
     lo que el remoto cambió o borró, nunca reintroduzcas líneas que el
     remoto sacó a propósito —, corré `hledger check`, cerrá el rebase
     (`rebase --continue`) y llamá `push`. Si el conflicto te excede,
     descartá el rebase (`rebase --abort`) y contale al usuario en una línea
     qué quedó pendiente.
   - `push_failed`: los commits están locales. Un reintento con `push`;
     si falla de nuevo, avisá y pará.
   - `blocked`: leé `reason`, arreglá la causa, no repitas la misma llamada.

   El git local (`add`, `commit`, `rebase`) lo hacés vos con `bash`. Solo la
   red pasa por las tools: `push` para publicar, `pull` para traer del
   remoto sin pushear. Nunca toques el remote ni pongas credenciales a mano.

8. **Si el usuario corrige algo** («no, eran 20 mil», «esa era EUR»): corregí
   el asiento aún no commiteado y volvé al paso 4. Si ya fue commiteado,
   agregá una transacción de corrección nueva y commiteala aparte.
