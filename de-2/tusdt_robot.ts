// Робот ДЭ-2 (21.11): честная проверка «клиент с 0 TRX переводит USDT» на Nile.
// Nile USDT (TXYZop...) платит энергию сам (процент пользователя 0) - на нем проверка 0 TRX ложно зеленая.
// Робот работает на своем токене tUSDT с оплатой 100% отправителем (как USDT в бою при пустой энергии владельца).
// ЗАМОК: перед любым прогоном робот читает контракт; Nile USDT или процент оплаты отправителем < 100 - отказ, код 3.
// Только Nile: адрес сети зашит. Живет на Oracle в ~/tron-one-node-nile/ рядом с nile_wallet.ts (берет @noble и src/tx.ts).
//   node tusdt_robot.ts init                 ключ владельца (файл 600, не печатается), TRX с крана, стейк на энергию, выпуск tUSDT
//   node tusdt_robot.ts check [ТОКЕН]        только замок токена
//   node tusdt_robot.ts give АДРЕС СУММА      выдать tUSDT (кран для П1 шага 4.3), до 300 за вызов
//   node tusdt_robot.ts send КЛЮЧ АДРЕС СУММА перевод tUSDT с кошелька клиента (П1 шага 4.3: на адрес пополнения)
//   node tusdt_robot.ts run                  прогон: W1 без энергии -> ждем OUT_OF_ENERGY; W2 с нашей энергией -> ждем SUCCESS, сожжено 0
// Итог: строка «ДЭ-2 робот: ЗЕЛЕНО|КРАСНОЕ» в журнал $ROBOT_DIR/robot.log и $ROBOT_DIR/last.json. Код 0 - ЗЕЛЕНО.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
export const UP = "https://nile.trongrid.io"; // только Nile, без переопределения
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Замок: можно ли проверять сценарий 0 TRX на этом токене. info - ответ /wallet/getcontract (visible). */
export function tokenLock(addr: string, info: any): { ok: boolean; why: string } {
  if (addr === NILE_USDT) return { ok: false, why: "ЛОЖНАЯ ПРОВЕРКА: Nile USDT платит энергию за отправителя (процент 0) - сценарий 0 TRX на нем всегда зеленый" };
  if (!info || !info.bytecode && !info.contract_address) return { ok: false, why: `контракт ${addr} не найден в Nile` };
  const p = Number(info.consume_user_resource_percent ?? 0); // поле пропадает, когда процент 0
  if (p !== 100) return { ok: false, why: `ЛОЖНАЯ ПРОВЕРКА: процент оплаты отправителем ${p}, нужен 100 - владелец контракта доплатит энергию за клиента` };
  return { ok: true, why: `токен ${addr}: платит отправитель 100%` };
}

/** Ответ /wallet/gettransactioninfobyid -> итог перевода. */
export function outcome(info: any): { result: string; fee: number; energyFee: number; netFee: number; energy: number; ownerPaid: number } {
  const rc = info?.receipt ?? {};
  return { result: String(rc.result ?? (info?.result === "FAILED" ? "FAILED" : "SUCCESS")), fee: Number(info?.fee ?? 0), energyFee: Number(rc.energy_fee ?? 0), netFee: Number(rc.net_fee ?? 0), energy: Number(rc.energy_usage_total ?? 0), ownerPaid: Number(rc.origin_energy_usage ?? 0) };
}

/** Вердикт робота: без энергии - OUT_OF_ENERGY (проверка ловит отсутствие энергии), с нашей энергией - SUCCESS и сожжено 0. */
export function verdict(red: any, green: any): { ok: boolean; lines: string[] } {
  const r = outcome(red), g = outcome(green), lines: string[] = [];
  const redOk = r.result === "OUT_OF_ENERGY";
  const greenOk = g.result === "SUCCESS" && g.fee === 0 && g.energyFee === 0 && g.netFee === 0 && g.ownerPaid === 0;
  lines.push(`без энергии: ${r.result} (ждали OUT_OF_ENERGY) ${redOk ? "ок" : "ПРОВАЛ: перевод прошел без нашей энергии - проверка ложная"}`);
  lines.push(`с нашей энергией: ${g.result}, сожжено ${g.fee} sun (энергия ${g.energyFee}, полоса ${g.netFee}), владелец контракта доплатил ${g.ownerPaid} ${greenOk ? "ок" : "ПРОВАЛ"}`);
  return { ok: redOk && greenOk, lines };
}

export function addrParam(a: string): string {
  let n = 0n; for (const ch of a) n = n * 58n + BigInt(B58.indexOf(ch));
  return n.toString(16).padStart(50, "0").slice(2, 42).padStart(64, "0");
}
const u256 = (v: bigint) => v.toString(16).padStart(64, "0");

// ---------- сеть и подпись (только при запуске, не при импорте в тест) ----------
const ROBOT_DIR = process.env["ROBOT_DIR"] ?? join(homedir(), "robot-nile", "tusdt");
const TAP = process.env["TAP_CMD"] ?? join(homedir(), "tron-one-node-nile", "nile_tap.sh");
const H: Record<string, string> = { "content-type": "application/json", ...(process.env["TRONGRID_API_KEY"] ? { "TRON-PRO-API-KEY": process.env["TRONGRID_API_KEY"]! } : {}) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown): Promise<any> => {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(UP + path, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); return JSON.parse(await r.text()); }
    catch (e) { if (i === 3) throw e; await sleep(2000 * (i + 1)); }
  }
};
let C: any; // крипто узла: подгружается лениво
async function crypto() {
  if (C) return C;
  const secp = await import("@noble/secp256k1"); const { sha256 } = await import("@noble/hashes/sha2.js"); const { hmac } = await import("@noble/hashes/hmac.js");
  const tx = await import(join(process.cwd(), "src", "tx.ts"));
  (secp as any).hashes.sha256 = sha256; (secp as any).hashes.hmacSha256 = (k: Uint8Array, m: Uint8Array) => hmac(sha256, k, m);
  return (C = { secp, ...tx });
}
const logf = () => join(ROBOT_DIR, "robot.log");
function log(s: string) { const l = `${new Date().toISOString()} ${s}`; console.log(l); appendFileSync(logf(), l + "\n"); }
async function genKey(file: string) { const c = await crypto(); const k = randomBytes(32); writeFileSync(file, c.bytesToHex(k) + "\n", { mode: 0o600 }); return k; }
async function keyOf(file: string) { const c = await crypto(); return c.hexToBytes(readFileSync(file, "utf8").trim()); }
async function addrOf(k: Uint8Array) { const c = await crypto(); return c.addressFromPubkey(c.secp.getPublicKey(k, false)); }
async function waitInfo(id: string) { for (let i = 0; i < 40; i++) { await sleep(3000); const r = await post("/wallet/gettransactioninfobyid", { value: id }); if (r?.id) return r; } return null; }
async function send(tx: any, k: Uint8Array, label: string) {
  if (!tx?.txID) throw new Error(`${label}: сборка не удалась ${JSON.stringify(tx).slice(0, 200)}`);
  const c = await crypto(); const sig = c.secp.sign(c.hexToBytes(tx.txID), k, { prehash: false, format: "recovered" });
  tx.signature = [c.bytesToHex(sig.slice(1)) + (sig[0]! + 27).toString(16).padStart(2, "0")];
  const r = await post("/wallet/broadcasttransaction", tx);
  if (!r?.result) throw new Error(`${label}: сеть не приняла ${tx.txID} ${r?.code ?? ""} ${r?.message ? Buffer.from(String(r.message), "hex").toString() : ""}`);
  const info = await waitInfo(tx.txID); const o = outcome(info);
  log(`${label}: txid=${tx.txID} ${info ? o.result : "нет в блоке за 120 с"} сожжено=${o.fee} энергия=${o.energy}`);
  return { txid: tx.txID, info };
}
const trx = async (k: Uint8Array, to: string, sun: number, l: string) => send(await post("/wallet/createtransaction", { owner_address: await addrOf(k), to_address: to, amount: sun, visible: true }), k, l);
async function tok(k: Uint8Array, token: string, to: string, minor: bigint, l: string) {
  const r = await post("/wallet/triggersmartcontract", { owner_address: await addrOf(k), contract_address: token, function_selector: "transfer(address,uint256)", parameter: addrParam(to) + u256(minor), fee_limit: 30_000_000, call_value: 0, visible: true });
  return send(r?.transaction ?? r, k, l);
}
const res = async (a: string) => post("/wallet/getaccountresource", { address: a, visible: true });
const tokenAddr = () => { const f = join(ROBOT_DIR, "token.addr"); if (!existsSync(f)) throw new Error("нет token.addr: сначала node tusdt_robot.ts init"); return readFileSync(f, "utf8").trim(); };
let RUN = false; // last.json пишет только прогон run: check/give/send итог прогона не затирают
const lastRed = (why: string) => { if (RUN) writeFileSync(join(ROBOT_DIR, "last.json"), JSON.stringify({ at: new Date().toISOString(), verdict: "КРАСНОЕ", why })); };
async function lockOrDie(addr: string) {
  const l = tokenLock(addr, await post("/wallet/getcontract", { value: addr, visible: true }));
  log(`замок: ${l.why}`); if (!l.ok) { lastRed(l.why); log("ДЭ-2 робот: КРАСНОЕ (замок)"); process.exit(3); }
}
/** Сколько TRX стейка можно делегировать: сеть вычитает долю уже потраченной энергии. Нужно sun, доступно max -> сколько доморозить. */
export function topUpStake(needSun: number, maxSun: number, balanceSun: number): number {
  if (maxSun >= needSun) return 0;
  const want = needSun * 3 - maxSun; const room = balanceSun - 50e6; // 50 TRX оставляем на полосу и активации
  if (room < needSun) throw new Error(`стейка не хватает: делегировать можно ${maxSun / 1e6} TRX, нужно ${needSun / 1e6}, свободно ${balanceSun / 1e6} TRX - кран nile_tap.sh trx владельцу`);
  return Math.ceil(Math.min(want, room) / 1e6) * 1e6;
}
async function ensureDelegatable(k: Uint8Array, me: string, sun: number) {
  const m = await post("/wallet/getcandelegatedmaxsize", { owner_address: me, type: 1, visible: true });
  const max = Number(m?.max_size ?? 0); const acc = await post("/wallet/getaccount", { address: me, visible: true });
  const add = topUpStake(sun, max, Number(acc.balance ?? 0));
  log(`стейк для делегирования: можно ${max / 1e6} TRX, нужно ${sun / 1e6}${add ? `, доморозка ${add / 1e6} TRX` : ""}`);
  if (!add) return;
  await send(await post("/wallet/freezebalancev2", { owner_address: me, frozen_balance: add, resource: "ENERGY", visible: true }), k, `доморозка ${add / 1e6} TRX на энергию`);
  const m2 = Number((await post("/wallet/getcandelegatedmaxsize", { owner_address: me, type: 1, visible: true }))?.max_size ?? 0);
  if (m2 < sun) throw new Error(`после доморозки делегировать можно ${m2 / 1e6} TRX, нужно ${sun / 1e6}`);
}

async function init() {
  const kf = join(ROBOT_DIR, "owner.key"); const k = existsSync(kf) ? await keyOf(kf) : await genKey(kf); const me = await addrOf(k);
  log(`владелец tUSDT ${me}`);
  const acc = await post("/wallet/getaccount", { address: me, visible: true });
  if ((acc.balance ?? 0) < 2600e6) { log("кран: 3000 TRX владельцу"); execFileSync("bash", [TAP, "trx", me, "3000"], { stdio: "inherit" }); await sleep(4000); }
  const r = await res(me);
  if ((r.EnergyLimit ?? 0) < 300_000) await send(await post("/wallet/freezebalancev2", { owner_address: me, frozen_balance: 2000e6, resource: "ENERGY", visible: true }), k, "стейк 2000 TRX на энергию");
  if (!existsSync(join(ROBOT_DIR, "token.addr"))) {
    const c = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tusdt_contract.json"), "utf8"));
    const tx = await post("/wallet/deploycontract", { owner_address: me, abi: JSON.stringify(c.abi), bytecode: c.bytecode + u256(10n ** 15n), consume_user_resource_percent: 100, origin_energy_limit: 1, fee_limit: 1_000_000_000, call_value: 0, name: "tUSDT", visible: true });
    const s = await send(tx, k, "выпуск tUSDT");
    const ca = s.info?.contract_address; if (!ca) throw new Error("адрес контракта не получен");
    const addr = b58check(ca);
    writeFileSync(join(ROBOT_DIR, "token.addr"), addr + "\n"); log(`tUSDT: ${addr}`);
  }
  await lockOrDie(tokenAddr());
}
export function b58check(hex: string): string {
  const b = Buffer.from(hex, "hex"); const h = createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
  const full = Buffer.concat([b, h.subarray(0, 4)]); let n = 0n; for (const x of full) n = n * 256n + BigInt(x);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of full) { if (x === 0) s = "1" + s; else break; } return s;
}

async function run() {
  const token = tokenAddr(); await lockOrDie(token);
  const k = await keyOf(join(ROBOT_DIR, "owner.key")); const me = await addrOf(k);
  const dir = join(ROBOT_DIR, "runs", new Date().toISOString().replace(/[:.]/g, "-")); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const w1 = await genKey(join(dir, "w1.key")), w2 = await genKey(join(dir, "w2.key")); const a1 = await addrOf(w1), a2 = await addrOf(w2);
  log(`прогон: W1 ${a1} (без энергии), W2 ${a2} (с нашей энергией); у обоих 0 TRX (активация 1 sun), 20 tUSDT`);
  for (const a of [a1, a2]) { await trx(k, a, 1, `активация ${a.slice(-4)}`); await tok(k, token, a, 20_000_000n, `20 tUSDT -> ${a.slice(-4)}`); }
  const r1 = await res(a1); if ((r1.EnergyLimit ?? 0) > 0) throw new Error("W1 не чистый: есть энергия");
  const red = await tok(w1, token, me, 5_000_000n, "W1 перевод без энергии");
  const est = await post("/wallet/triggerconstantcontract", { owner_address: a2, contract_address: token, function_selector: "transfer(address,uint256)", parameter: addrParam(me) + u256(5_000_000n), visible: true });
  const need = Math.ceil(Number(est.energy_used ?? 30_000) * 1.2); const rm = await res(me);
  const sun = Math.max(1, Math.ceil(need * Number(rm.TotalEnergyWeight) / Number(rm.TotalEnergyLimit))) * 1_000_000;
  await ensureDelegatable(k, me, sun);
  await send(await post("/wallet/delegateresource", { owner_address: me, receiver_address: a2, balance: sun, resource: "ENERGY", lock: false, visible: true }), k, `наша энергия ${need} -> W2 (${sun / 1e6} TRX стейка)`);
  const green = await tok(w2, token, me, 5_000_000n, "W2 перевод с нашей энергией");
  await send(await post("/wallet/undelegateresource", { owner_address: me, receiver_address: a2, balance: sun, resource: "ENERGY", visible: true }), k, "возврат энергии");
  const v = verdict(red.info, green.info); v.lines.forEach((l) => log(l));
  const out = { at: new Date().toISOString(), token, verdict: v.ok ? "ЗЕЛЕНО" : "КРАСНОЕ", red: { txid: red.txid, ...outcome(red.info) }, green: { txid: green.txid, ...outcome(green.info) }, lines: v.lines };
  writeFileSync(join(ROBOT_DIR, "last.json"), JSON.stringify(out, null, 1));
  log(`ДЭ-2 робот: ${out.verdict} red=${red.txid} green=${green.txid}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(ROBOT_DIR, { recursive: true, mode: 0o700 });
  const [cmd, x, y] = process.argv.slice(2);
  const main = async () => {
    if (cmd === "init") return init();
    if (cmd === "check") return lockOrDie(x ?? tokenAddr());
    if (cmd === "run") { RUN = true; return run(); }
    if (cmd === "give" && x && y) {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(x) || !(Number(y) > 0 && Number(y) <= 300)) throw new Error("адрес T... и сумма 0..300");
      const t = tokenAddr(); await lockOrDie(t);
      return void (await tok(await keyOf(join(ROBOT_DIR, "owner.key")), t, x, BigInt(Math.round(Number(y) * 1e6)), `кран tUSDT ${y} -> ${x}`));
    }
    if (cmd === "send" && x && y && process.argv[5]) { // клиентский кошелек робота П1 шага 4.3: перевод tUSDT со своего ключа
      const amt = process.argv[5]; if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(y) || !(Number(amt) > 0 && Number(amt) <= 300)) throw new Error("send КЛЮЧ-ФАЙЛ АДРЕС СУММА (0..300)");
      const t = tokenAddr(); await lockOrDie(t);
      return void (await tok(await keyOf(x), t, y, BigInt(Math.round(Number(amt) * 1e6)), `перевод tUSDT ${amt} -> ${y}`));
    }
    console.log("команды: init | check [ТОКЕН] | give АДРЕС СУММА | send КЛЮЧ-ФАЙЛ АДРЕС СУММА | run"); process.exit(2);
  };
  main().catch((e) => { const m = `ОШИБКА: ${e?.message ?? e}`; log(m); lastRed(m); if (RUN) log("ДЭ-2 робот: КРАСНОЕ (ошибка прогона)"); process.exit(2); });
}
