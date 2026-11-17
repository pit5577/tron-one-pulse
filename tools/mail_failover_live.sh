#!/usr/bin/env bash
# Шаг 1.3 плана: живая проверка запасного почтовика (Resend) в бою. Мак, Терминал или сессия Мака по фразе Ивана.
#   bash mail_failover_live.sh key     - ИВАН, один раз: окно со скрытым полем -> ключ Resend в ~/.tronone/resend_key.env (600),
#                                        проверка ключа и домена в Resend, запись RESEND_API_KEY и RESEND_FROM в .env боя (бэкап).
#                                        Джарвис не перезапускаем: ключ подхватит очередная выкладка.
#   bash mail_failover_live.sh check   - только чтение: ключ в бою, домен подтвержден, в бою код с переключением на 401/403. ЗЕЛЕНО/СТОП
#   bash mail_failover_live.sh off     - П1: ключ Postmark в .env боя заменяется неверным (бэкап), рестарт Джарвиса.
#                                        Страховка: через 20 мин бой сам возвращает ключ и перезапускается, если не было «on».
#   bash mail_failover_live.sh on      - П3: настоящий ключ Postmark из бэкапа, рестарт Джарвиса.
#   bash mail_failover_live.sh log     - письма с кодом за 2 ч: через какой почтовик (email маской, кода в журнале нет).
# Секреты не печатаются (только sha256 по 8 знакам), по ssh идут через stdin, на сервере меняются только на сервере.
set -uo pipefail
MODE="${1:-}"
K="${UPCLOUD_SSH_KEY:-$HOME/.ssh/tronone_upcloud}"
PROD="${PROD_SSH:-ubuntu@100.107.227.45}"
SSHO=(-o BatchMode=yes -i "$K" -o IdentitiesOnly=yes -o HostKeyAlias=94.237.4.105)
PENV="${PROD_ENV:-/home/ubuntu/tron-one/.env}"
SEC="$HOME/.tronone"; RK="$SEC/resend_key.env"
FROM="${RESEND_FROM:-code@tronone.io}"
U=tronone-jarvis
h8() { shasum -a 256 2>/dev/null | cut -c1-8 || sha256sum | cut -c1-8; }
prod() { ssh "${SSHO[@]}" "$PROD" "$@"; }

resend_domain() {   # $1 - ключ; печатает «verified»/статус домена отправителя или ошибку
  local d="${FROM##*@}"
  curl -s --max-time 15 -H "Authorization: Bearer $1" https://api.resend.com/domains |
    python3 -c 'import json,sys
d=sys.argv[1]
try: j=json.load(sys.stdin)
except Exception: print("нет ответа"); sys.exit()
if "data" not in j: print("ключ отклонен: "+str(j.get("name") or j.get("message") or j)[:80]); sys.exit()
m=[x for x in j["data"] if x.get("name")==d]
print(m[0].get("status","?") if m else "домена "+d+" нет в Resend")' "$d"
}

case "$MODE" in
key)
  KEY="$(osascript -e 'text returned of (display dialog "Ключ Resend (re_...). Вставь и нажми OK - в чат он не попадет." default answer "" with hidden answer with title "Tron One")' 2>/dev/null)"
  KEY="$(printf %s "$KEY" | tr -d '[:space:]')"
  case "$KEY" in re_*) ;; *) echo "СТОП: ключ пустой или не начинается с re_"; exit 1;; esac
  ( umask 077; mkdir -p "$SEC"; printf 'RESEND_API_KEY=%s\n' "$KEY" > "$RK" )
  ST="$(resend_domain "$KEY")"
  echo "ключ на Маке: <sha $(printf %s "$KEY" | h8)>, домен ${FROM##*@} в Resend: $ST"
  # «ключ отклонен: restricted_api_key» - ключ только на отправку: домен им не прочитать, это нормально
  case "$ST" in verified|*restricted*) ;; *) echo "СТОП: домен не подтвержден - письма Resend не уйдут. Ключ сохранен на Маке, в бой не записан."; exit 1;; esac
  { printf 'RK=%q\nRF=%q\n' "$KEY" "$FROM"; sed "s#__PENV__#$PENV#" <<'REMOTE'
set -uo pipefail
E="__PENV__"; [ -f "$E" ] || { echo "СТОП: нет $E"; exit 1; }
B="$E.bak-$(date -u +%Y%m%dT%H%M%SZ)-resend"; cp -p "$E" "$B"; chmod 600 "$B"
T="$(mktemp)"; chmod 600 "$T"; grep -vE '^(RESEND_API_KEY|RESEND_FROM)=' "$E" > "$T"
printf '# шаг 1.3 запасной почтовик (%s)\nRESEND_API_KEY=%s\nRESEND_FROM=%s\n' "$(date -u +%FT%TZ)" "$RK" "$RF" >> "$T"
cat "$T" > "$E"; rm -f "$T"; chmod 600 "$E"
echo "бой: бэкап $B; RESEND_API_KEY=<sha $(grep '^RESEND_API_KEY=' "$E" | cut -d= -f2- | tr -d '\n' | sha256sum | cut -c1-8)> RESEND_FROM=$(grep '^RESEND_FROM=' "$E" | cut -d= -f2-)"
REMOTE
  } | prod 'bash -s'
  echo "Готово. Ключ включится с очередной выкладкой (рестарт Джарвиса)."
  ;;
check)
  ok=1
  KEY="$(grep -E '^RESEND_API_KEY=' "$RK" 2>/dev/null | cut -d= -f2-)"
  if [ -n "$KEY" ]; then ST="$(resend_domain "$KEY")"; echo "Resend: ключ на Маке <sha $(printf %s "$KEY" | h8)>, домен: $ST"
  else echo "Resend: ключа на Маке нет"; ok=0; fi
  R="$(prod "bash -s" <<REMOTE
E="$PENV"; v=\$(grep '^RESEND_API_KEY=' "\$E" | tail -1 | cut -d= -f2- | tr -d '\n')
echo "env=\${v:+<sha \$(printf %s "\$v" | sha256sum | cut -c1-8)>}"
pid=\$(systemctl show $U -p MainPID --value); echo "live=\$(sudo cat /proc/\$pid/environ 2>/dev/null | tr '\0' '\n' | grep -c '^RESEND_API_KEY=.')"
echo "code=\$(grep -c 'e.reason === \"silenced\"' ~/tron-one-backend/src/auth/mailer.ts 2>/dev/null)"
echo "silence=\$(grep -A12 '\"api.postmarkapp.com\"' ~/tron-one-backend/src/net/egress_budget.json 2>/dev/null | grep -o '\"silence_s\": [0-9]*' | grep -o '[0-9]*$')"
REMOTE
)"
  echo "$R"
  grep -q '^env=<sha' <<<"$R" || { echo "- в .env боя нет RESEND_API_KEY"; ok=0; }
  grep -q '^live=1' <<<"$R" || { echo "- Джарвис запущен без RESEND_API_KEY (нужен рестарт или выкладка)"; ok=0; }
  grep -q '^code=[1-9]' <<<"$R" || { echo "- в бою старый почтовик: 401/403 не переключают (вагон mail-failover не выложен)"; ok=0; }
  grep -q '^silence=900' <<<"$R" || { echo "- тишина Postmark в бою не 15 мин"; ok=0; }
  [ "$ok" = 1 ] && echo "ЗЕЛЕНО: можно off" || { echo "СТОП"; exit 1; }
  ;;
off)
  prod "bash -s" <<REMOTE
set -uo pipefail
E="$PENV"; B="\$E.bak-mailtest"
[ -f "\$B" ] && { echo "СТОП: проверка уже идет (\$B есть) - сначала on"; exit 1; }
grep -q '^RESEND_API_KEY=.' "\$E" || { echo "СТОП: в .env нет RESEND_API_KEY - писем не будет совсем"; exit 1; }
cp -p "\$E" "\$B"; chmod 600 "\$B"
sed -i 's/^POSTMARK_TOKEN=.*/POSTMARK_TOKEN=off-mailtest-invalid/' "\$E"
sudo systemctl restart $U; sleep 4
# страховка: через 20 мин вернуть ключ сам (если on не было)
sudo systemd-run --unit=tronone-mailtest-restore --on-active=20min /bin/bash -c "[ -f \$B ] && cp -p \$B \$E && rm -f \$B && systemctl restart $U" >/dev/null 2>&1 || echo "ВНИМАНИЕ: страховка 20 мин не поставлена"
echo "основной выключен \$(date -u +%FT%TZ), Джарвис: \$(systemctl is-active $U). Иван: войди по почте сейчас. Возврат: on (или сам через 20 мин)"
REMOTE
  ;;
on)
  prod "bash -s" <<REMOTE
set -uo pipefail
E="$PENV"; B="\$E.bak-mailtest"
[ -f "\$B" ] || { echo "ключ уже на месте (бэкапа проверки нет)"; exit 0; }
cp -p "\$B" "\$E" && rm -f "\$B"; sudo systemctl stop tronone-mailtest-restore.timer 2>/dev/null
sudo systemctl restart $U; sleep 4
echo "основной вернулся \$(date -u +%FT%TZ), POSTMARK_TOKEN=<sha \$(grep '^POSTMARK_TOKEN=' "\$E" | cut -d= -f2- | tr -d '\n' | sha256sum | cut -c1-8)>, Джарвис: \$(systemctl is-active $U). Иван: войди по почте еще раз"
REMOTE
  ;;
log)
  prod "journalctl -u $U --since '2 hours ago' -o short-iso --no-pager | grep -E 'auth code sent|пробую resend|postmarkapp.com/client|auth email on' | tail -20"
  ;;
*) sed -n 2,11p "$0"; exit 1;;
esac
