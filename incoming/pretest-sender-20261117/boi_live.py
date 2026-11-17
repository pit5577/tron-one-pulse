#!/usr/bin/env python3
"""Сводка боя для проверки перед тестом Ивана (шаг С-4). Запускается на Маке launchd раз в 10 мин.

Только чтение: одна ssh-команда на боевую машину (служба Джарвиса, подключен ли Банк, версия выкладки),
три запроса к TronGrid (полоса адреса Ивана и Банка), метка сборки страницы. Итог - live/boi.json
в открытом репозитории пульса через gh api: без адресов, ключей и значений окружения - только вкл/выкл, версии, числа.
Облако читает его командой tron.py test "цель" и утром. Сбой любой части - поле ошибки, облако скажет СТОП.
Вручную: python3 boi_live.py [--print] (--print - показать и не отправлять)
"""
import base64
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

SSH = ["ssh", "-i", "~/.ssh/tronone_upcloud", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "ubuntu@94.237.4.105"]
IVAN = "TNbpjh52ZS4rjC2BAPeefsbak4EWDq6qEy"
# Правило №0 17.11: проверка перед тестом смотрит только адрес отправителя (tron.py test --from). Адреса берем из
# users.json узла боя (только поле addresses), в сводку кладем ключом sha256[:16] - адресов в открытом репо нет.
NODE_SSH = os.environ.get("NODE_SSH", "ubuntu@100.78.56.33").split()
NODE_USERS = os.environ.get("NODE_USERS", "/opt/tronone-node/users.json")
SENDERS_MAX = 30
BANK = "TSJK55YRgBojtLS4bgfzgchzR1FmseoGaP"
REPO = "pit5577/tron-one-pulse"
PATH = "live/boi.json"
MSK = dt.timezone(dt.timedelta(hours=3))
DAY_MS = 86_400_000

REMOTE = r"""
u=tronone-jarvis
echo "state=$(systemctl show $u -p ActiveState --value)"
echo "since=$(date -d "$(systemctl show $u -p ActiveEnterTimestamp --value)" +%s 2>/dev/null)"
echo "reload=$(systemctl show $u -p NeedDaemonReload --value)"
d=/etc/systemd/system/$u.service.d/10-bank.conf
echo "dropin=$(stat -c %Y $d 2>/dev/null)"
for k in BW_BANK_ADDRESS SIGNER_SOCKET; do
  v=$(systemctl show $u -p Environment --value | tr ' ' '\n' | grep "^$k=" | cut -d= -f2-)
  [ -n "$v" ] && echo "env_$k=1" || echo "env_$k=0"
  [ "$k" = SIGNER_SOCKET ] && [ -n "$v" ] && { [ -S "$v" ] && echo "sock=1" || echo "sock=0"; }
done
echo "manifest=$(grep -m1 '^# prod-' ~/tron-one-backend/MANIFEST.md5 2>/dev/null)"
"""


def ssh_facts():
    r = subprocess.run(SSH + ["bash", "-s"], input=REMOTE, capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError("ssh: " + (r.stderr.strip()[-120:] or f"код {r.returncode}"))
    return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)


def node_addresses():
    """Адреса из users.json узла боя (только чтение, без ключей)."""
    py = ("import json,sys;d=json.load(open(sys.argv[1]));u=d.values() if isinstance(d,dict) else d;"
          "print('\\n'.join(sorted({a for x in u if isinstance(x,dict) for a in (x.get('addresses') or [])})))")
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"] + NODE_SSH + ["sudo", "python3", "-c", py, NODE_USERS],
                       capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError("узел: " + (r.stderr.strip()[-120:] or f"код {r.returncode}"))
    return [a for a in r.stdout.split() if a.startswith("T") and len(a) == 34][:SENDERS_MAX]


def bw(addr, now_ms):
    ri, ai = tron("getaccountresource", {"address": addr, "visible": True}), tron("getaccount", {"address": addr, "visible": True})
    free_used = recovered(ai.get("free_net_usage", ri.get("freeNetUsed", 0)), ai.get("latest_consume_free_time"), now_ms)
    own_used = recovered(ai.get("net_usage", ri.get("NetUsed", 0)), ai.get("latest_consume_time"), now_ms)
    return {"бесплатно_всего": ri.get("freeNetLimit", 600), "бесплатно_осталось": max(ri.get("freeNetLimit", 600) - free_used, 0),
            "своя_осталось": max(ri.get("NetLimit", 0) - own_used, 0)}


def tron(method, body):
    req = urllib.request.Request("https://api.trongrid.io/wallet/" + method, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as f:
        return json.loads(f.read() or b"{}")


def recovered(used, last_ms, now_ms):
    """Полоса восстанавливается за сутки линейно: сколько из used еще занято сейчас."""
    if not used or not last_ms:
        return int(used or 0)
    left = DAY_MS - (now_ms - last_ms)
    return 0 if left <= 0 else int(used * left / DAY_MS)


def chain():
    now_ms = int(dt.datetime.now().timestamp() * 1000)
    ri, ai = tron("getaccountresource", {"address": IVAN, "visible": True}), tron("getaccount", {"address": IVAN, "visible": True})
    free_used = recovered(ai.get("free_net_usage", ri.get("freeNetUsed", 0)), ai.get("latest_consume_free_time"), now_ms)
    own_used = recovered(ai.get("net_usage", ri.get("NetUsed", 0)), ai.get("latest_consume_time"), now_ms)
    ivan = {"бесплатно_всего": ri.get("freeNetLimit", 600), "бесплатно_осталось": max(ri.get("freeNetLimit", 600) - free_used, 0),
            "своя_осталось": max(ri.get("NetLimit", 0) - own_used, 0)}
    senders = {hashlib.sha256(a.encode()).hexdigest()[:16]: bw(a, now_ms) for a in node_addresses()}
    rb = tron("getaccountresource", {"address": BANK, "visible": True})
    md = tron("getcandelegatedmaxsize", {"owner_address": BANK, "type": 0, "visible": True}).get("max_size", 0)
    per_trx = rb.get("TotalNetLimit", 0) / max(rb.get("TotalNetWeight", 1), 1)
    return {"ок": True, "иван": ivan, "отправители": senders, "банк": {"полоса_свободно": int(md / 1e6 * per_trx)}}


def page_build():
    req = urllib.request.Request("https://m.tronone.io/", headers={"User-Agent": "curl/8.7.1"})   # Cloudflare режет подпись Python (403)
    with urllib.request.urlopen(req, timeout=20) as f:
        html = f.read().decode("utf-8", "replace")
    i = html.find('name="jarvis-build"')
    if i < 0:
        return ""
    j = html.find('content="', i)
    return html[j + 9: html.find('"', j + 9)] if j > 0 else ""


def snapshot():
    now = dt.datetime.now(MSK)
    out = {"t": now.strftime("%Y-%m-%dT%H:%M:%S%z"), "бой": {"ок": False}, "сеть": {"ок": False}, "ошибки": []}
    try:
        f = ssh_facts()
        since, dropin = int(f.get("since") or 0), int(f.get("dropin") or 0)
        bank = f.get("env_BW_BANK_ADDRESS") == "1" and f.get("env_SIGNER_SOCKET") == "1" and f.get("sock") == "1"
        man = f.get("manifest", "").lstrip("# ").split()
        ver = " · ".join(x.replace("backend=", "backend ") for x in man if not x.startswith("dev=")) if man else ""
        out["бой"] = {"ок": True, "джарвис": f.get("state", "?"), "джарвис_с": dt.datetime.fromtimestamp(since, MSK).strftime("%Y-%m-%dT%H:%M%z") if since else "",
                      "банк": bank, "банк_ждет_рестарта": bool(bank and (f.get("reload") == "yes" or dropin > since)),
                      "сокет_подписанта": f.get("sock") == "1", "версия": ver}
    except Exception as e:
        out["ошибки"].append(f"бой: {e}"[:160])
    try:
        out["бой"]["страница"] = page_build()
    except Exception as e:
        out["ошибки"].append(f"страница: {e}"[:160])
    try:
        out["сеть"] = chain()
    except Exception as e:
        out["ошибки"].append(f"сеть: {e}"[:160])
    return out


def push(data):
    body = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    r = subprocess.run(["gh", "api", f"repos/{REPO}/contents/{PATH}", "--jq", ".sha"], capture_output=True, text=True)
    args = ["gh", "api", "-X", "PUT", f"repos/{REPO}/contents/{PATH}", "-f", "message=boi " + data["t"],
            "-f", "content=" + base64.b64encode(body.encode()).decode()]
    if r.returncode == 0 and r.stdout.strip():
        args += ["-f", "sha=" + r.stdout.strip()]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError("gh: " + (p.stderr.strip()[-200:]))


if __name__ == "__main__":
    d = snapshot()
    if "--print" in sys.argv:
        print(json.dumps(d, ensure_ascii=False, indent=1))
    else:
        push(d)
        print("отправлено", d["t"], "ошибок", len(d["ошибки"]))
