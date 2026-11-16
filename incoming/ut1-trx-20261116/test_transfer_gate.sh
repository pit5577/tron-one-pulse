#!/bin/bash
# Тест transfer_gate.sh без сети: подмена песочницы (SANDBOX_RUN) и git-метки во временном репо.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git init -q "$T/be" && git -C "$T/be" -c user.email=t@t -c user.name=t commit -q --allow-empty -m x && git -C "$T/be" tag prod-1-backend
mkdir -p "$T/dev"; FAIL=0
fake() { cat > "$T/fake.sh" <<F
#!/bin/bash
cat >/dev/null; echo "\$1" >> "$T/calls"
if [ "\$1" = md5 ]; then echo abcd1234; exit 0; fi
printf '%s\n' "== TRX ==" "txid aa" "$1" "== USDT ==" "txid bb" "$2"
F
chmod +x "$T/fake.sh"; }
run() { DEV_REPO="$T/dev" BACKEND_REPO="$T/be" SANDBOX_RUN="$T/fake.sh" /bin/bash "$HERE/transfer_gate.sh" prod-1 >/dev/null 2>&1; echo $?; }
OK="блок 5 через 6 с: SUCCESS; сожжено TRX 0.000000; energy_usage_total 0, energy_fee 0, net_usage 270, net_fee 0"
BURN="блок 5 через 6 с: SUCCESS; сожжено TRX 0.270000; energy_usage_total 0, energy_fee 0, net_usage 0, net_fee 270000"
check() { [ "$2" = "$3" ] && echo "ok - $1" || { echo "not ok - $1 (ждали $3, вышло $2)"; FAIL=1; }; }
fake "$BURN" "$OK"; check "TRX сжег 0,27 - КРАСНО" "$(run)" 1
fake "$OK" "broadcast via ... OTHER_ERROR"; check "USDT не дошел до блока - КРАСНО" "$(run)" 1
fake "$OK" "$OK"; : > "$T/calls"; check "оба SUCCESS и 0 - ЗЕЛЕНО" "$(run)" 0
: > "$T/calls"; check "тот же код - сеть не трогаем" "$(run)-$(grep -c run "$T/calls")" "0-0"
fake "$OK" "$OK"; sed -i.b 's/abcd1234/ffff0000/' "$T/fake.sh"; : > "$T/calls"; check "узел изменился - новый прогон" "$(run)-$(grep -c run "$T/calls")" "0-1"
check "нет метки - КРАСНО" "$(DEV_REPO="$T/dev" BACKEND_REPO="$T/be" SANDBOX_RUN="$T/fake.sh" /bin/bash "$HERE/transfer_gate.sh" prod-9 >/dev/null 2>&1; echo $?)" 1
exit $FAIL
