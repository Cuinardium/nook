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
   `hledger bal -p "today"`. Si hay error, corregilo antes de seguir.

5. **Proponer**: mostrale al usuario el bloque completo de la transacción tal
   cual quedó escrito, más una línea explicando la categoría elegida si hubo
   duda. Esperá su confirmación implícita llamando `commit_entry` recién
   cuando el asiento mostrado es el definitivo.

6. **Commitear**: llamá `commit_entry` con `message` descriptivo (misma frase
   de la descripción de la transacción). Si devuelve sha, reportalo. Si vuelve
   con `committed: false`, contale el motivo al usuario y no reintentes sin más.

7. **Si el usuario corrige algo** («no, eran 20 mil», «esa era EUR»): corregí
   el asiento aún no commiteado y volvé al paso 4. Si ya fue commiteado,
   agregá una transacción de corrección nueva y commiteala aparte.
