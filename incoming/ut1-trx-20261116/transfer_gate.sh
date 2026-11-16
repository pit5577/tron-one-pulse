#!/bin/bash
# transfer_gate.sh - ворота «перевод TRX и USDT проходит» (УТ-1, Иван 16.11, замок КП-1). Совместим с /bin/bash 3.2 (Мак).
#   transfer_gate.sh <метка>     с Мака; зовет deploy_one.sh (G6) перед выкладкой
# По событию, не по часам: итог хранится по отпечатку кода (коммит сервера метки + md5 узла песочницы). Отпечаток уже
# зеленый - сеть не трогаем (0 запросов, 0 токенов). Код изменился - один перевод TRX и один USDT на Nile через наш узел
# песочницы. ЗЕЛЕНО - оба SUCCESS и сожжено 0 TRX. Иначе КРАСНО, выкладка не едет. Модели нет, настоящих денег нет (Nile).
# Разовая подготовка на песочнице (Сборщик): ключ тестового кошелька $GATE_KEY (600, адрес в users.json узла Nile с
# "catfee": true), на нем TRX и USDT Nile; файл $GATE_VIA (600) - личный URL узла http://127.0.0.1:<порт>/n/<токен>;
# файл $GATE_TO - активный адрес Nile получателя (не контракт). nile_wallet.ts - в каталоге узла Nile (builder/nile-wallet).
set -uo pipefail
L="${1:?метка prod-...}"
DEV="${DEV_REPO:-$HOME/tron-one}"; BE="${BACKEND_REPO:-$HOME/tron-one-backend}"
OUT="$DEV/build/transfer_gate"
OKEY="${ORACLE_SSH_KEY:-$HOME/.ssh/tronone_oracle}"; OHOST="${ORACLE_SSH:-ubuntu@130.110.14.249}"
# Подмена для теста: SANDBOX_RUN - команда вместо ssh (читает скрипт со stdin, аргументы как у удаленного bash -s)
RUN="${SANDBOX_RUN:-ssh -i $OKEY -o IdentitiesOnly=yes -o BatchMode=yes $OHOST bash -s}"
say() { echo "[$(date +%H:%M:%S)] $*"; }

BREV="$(git -C "$BE" rev-parse -q --verify "$L-backend^{commit}" 2>/dev/null)" || BREV=""
[ -n "$BREV" ] || { say "КРАСНО: нет метки $L-backend"; exit 1; }
# Ревью Fable В3: отпечаток - весь код узла песочницы (src/*.ts), кошелек ворот nile_wallet.ts и сам скрипт ворот
NODE_MD5="$($RUN md5 <<'REMOTE'
D="${NILE_NODE_DIR:-$HOME/tron-one-node-nile}"; [ -f "$D/src/node.ts" ] && [ -f "$D/nile_wallet.ts" ] || exit 0
cat "$D"/src/*.ts "$D/nile_wallet.ts" | md5sum | cut -c1-8
REMOTE
)"
[ -n "$NODE_MD5" ] || { say "КРАСНО: узел песочницы не прочитан (нет src/node.ts или nile_wallet.ts)"; exit 1; }
SELF="$( (md5sum "$0" 2>/dev/null || md5 -q "$0") | cut -c1-6)"
FP="${BREV:0:8}-$NODE_MD5-$SELF"; mkdir -p "$OUT/$FP"; RES="$OUT/$FP/result.txt"
if [ -f "$RES" ] && grep -q '^status=GREEN' "$RES"; then say "ЗЕЛЕНО (уже проверено): $FP, сеть не трогали"; exit 0; fi

say "Код изменился ($FP): перевод TRX и USDT на Nile через узел песочницы"
OUTX="$($RUN run <<'REMOTE'
set -uo pipefail
D="${NILE_NODE_DIR:-$HOME/tron-one-node-nile}"; KEY="${GATE_KEY:-$HOME/nile-gate/key}"; VIAF="${GATE_VIA:-$HOME/nile-gate/via}"
TOF="${GATE_TO:-$HOME/nile-gate/to}"
[ -f "$KEY" ] && [ -f "$VIAF" ] && [ -f "$TOF" ] || { echo "ERR нет ключа, URL узла или получателя ($KEY, $VIAF, $TOF)"; exit 0; }
TO="$(cat "$TOF")"
cd "$D" || { echo "ERR нет $D"; exit 0; }
VIA="$(cat "$VIAF")"
echo "== TRX =="; node nile_wallet.ts trx "$KEY" "$TO" 1 "$VIA" 2>&1 | grep -E '^(txid|broadcast|блок|в блоке)'
echo "== USDT =="; node nile_wallet.ts usdt "$KEY" "$TO" 0.01 "$VIA" 2>&1 | grep -E '^(txid|broadcast|блок|в блоке)'
REMOTE
)"
printf '%s\n' "$OUTX"
# Итог одного перевода: блок с SUCCESS и сожжено 0
verdict() { printf '%s\n' "$OUTX" | awk -v s="== $1 ==" '$0==s{f=1;next} /^== /{f=0} f' | grep -E '^блок .*: SUCCESS; сожжено TRX 0\.000000;' >/dev/null && echo ok || echo fail; }
VT="$(verdict TRX)"; VU="$(verdict USDT)"
STATUS=GREEN; { [ "$VT" = ok ] && [ "$VU" = ok ]; } || STATUS=RED
{ echo "status=$STATUS"; echo "label=$L"; echo "fp=$FP"; echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "trx=$VT"; echo "usdt=$VU"; echo "--"; printf '%s\n' "$OUTX"; } > "$RES"
if [ "$STATUS" = GREEN ]; then say "ЗЕЛЕНО: TRX и USDT прошли, сожжено 0 ($RES)"; exit 0; fi
say "КРАСНО: TRX=$VT USDT=$VU - выкладка не едет ($RES)"; exit 1
