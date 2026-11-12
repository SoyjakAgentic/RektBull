"""
Copies what the pump.fun check needs from Solana mainnet into solana/fixtures/pump/ (not committed):
pump.fun's program and its fee program, and the accounts of one live, SOL-paired bonding curve found from a
recent v3 trade. Read-only: public RPC reads and `solana program dump`. Then:
  cargo test -p rektbull-orders --test pump_fun -- --ignored
Usage: python3 -I scripts/pump_fixtures.py [RPC URL]   (default: the public mainnet RPC)
"""
import base64, hashlib, json, os, struct, subprocess, sys, time, urllib.error, urllib.request

RPC = sys.argv[1] if len(sys.argv) > 1 else 'https://api.mainnet-beta.solana.com'
PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
WSOL = 'So11111111111111111111111111111111111111112'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'pump')
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), headers={'content-type': 'application/json'})
    for attempt in range(8):  # the public RPC rate-limits: back off and retry
        try:
            time.sleep(0.25)
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if 'error' in r:
                if r['error'].get('code') == 429 or 'rate' in str(r['error']).lower(): raise urllib.error.HTTPError(RPC, 429, 'rate', None, None)
                return None  # e.g. a transaction this RPC no longer serves: skipped
            return r['result']
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(2 ** attempt)
    raise SystemExit('the RPC kept rate-limiting; pass a private RPC URL')

def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return b'\0' * (len(s) - len(s.lstrip('1'))) + raw

DISC = {hashlib.sha256(('global:' + n).encode()).digest()[:8]: n for n in ('buy_v3', 'sell_v3', 'buy_exact_quote_in_v3')}

def live(curve):
    v = rpc('getAccountInfo', [curve, {'encoding': 'base64'}])
    data = base64.b64decode(v['value']['data'][0]) if v and v['value'] else b''
    return len(data) > 48 and data[48] == 0  # not complete: still on the curve

def find_curves():
    """The accounts of one live SOL-paired curve, from a recent successful trade with pump.fun's v3 instructions."""
    found = {}
    for s in rpc('getSignaturesForAddress', [PUMP, {'limit': 1000}]):
        if s['err']: continue
        tx = rpc('getTransaction', [s['signature'], {'encoding': 'json', 'maxSupportedTransactionVersion': 0}])
        if not tx: continue
        la = tx['meta'].get('loadedAddresses') or {}
        keys = tx['transaction']['message']['accountKeys'] + la.get('writable', []) + la.get('readonly', [])
        ixs = list(tx['transaction']['message']['instructions'])
        for inner in tx['meta'].get('innerInstructions') or []: ixs += inner['instructions']
        for ix in ixs:
            name = DISC.get(b58d(ix['data'])[:8]) if keys[ix['programIdIndex']] == PUMP else None
            if not name: continue
            acc = [keys[i] for i in ix['accounts']]
            if name.endswith('v3') and 'v3' not in found and acc[2] == WSOL and live(acc[5]):
                found['v3'] = {'global': acc[0], 'base_mint': acc[1], 'base_token_program': acc[3], 'bonding_curve': acc[5],
                               'associated_base_bonding_curve': acc[6], 'fee_config': acc[12], 'buyback_fee_recipient': acc[13],
                               'event_authority': acc[15], 'from': name, 'signature': s['signature'], 'slot': tx['slot'], 'block_time': tx['blockTime']}
        if found: break
    if not found: sys.exit('no live SOL-paired curve traded with v3 in the last 1,000 transactions; run again')
    return found

def dump_account(name, address):
    v = rpc('getAccountInfo', [address, {'encoding': 'base64'}])['value']
    if v is None: return False
    json.dump({'address': address, 'lamports': v['lamports'], 'owner': v['owner'], 'executable': v['executable'], 'data': v['data'][0]},
              open(os.path.join(OUT, f'{name}.json'), 'w'))
    return True

os.makedirs(OUT, exist_ok=True)
curves = find_curves()
for kind, c in curves.items():
    for name, address in c.items():
        if name in ('from', 'signature', 'slot', 'block_time', 'base_token_program'): continue
        if not dump_account(f'{kind}_{name}', address): print(f'  {kind} {name}: no account onchain (a PDA with no data)')
for prog, file in ((PUMP, 'pump.so'), (FEE_PROGRAM, 'pump_fees.so')):
    subprocess.run(['solana', 'program', 'dump', '-u', RPC, prog, os.path.join(OUT, file)], check=True, stdout=subprocess.DEVNULL)
json.dump(curves, open(os.path.join(OUT, 'curves.json'), 'w'), indent=1)
print(json.dumps(curves, indent=1))
