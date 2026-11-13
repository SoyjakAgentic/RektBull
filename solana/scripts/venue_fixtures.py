"""
Copies what the PumpSwap and Jupiter checks need from Solana mainnet into solana/fixtures/venues/ (not committed).
Read-only: public RPC reads, Jupiter's public quote API and `solana program dump`.

- PumpSwap: one live pool quoted in wrapped SOL, found from a recent successful trade, with every account that
  trade's instruction used, and PumpSwap's program.
- Jupiter: real quotes for the order program's transit address as the trader (wrapped SOL to USDC, and back),
  their swap instructions, every account and program they touch, and their address lookup tables.

Then: cargo test -p rektbull-orders --test venues -- --ignored
Usage: python3 -I scripts/venue_fixtures.py [RPC URL]   (default: the public mainnet RPC)
"""
import base64, hashlib, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

RPC = sys.argv[1] if len(sys.argv) > 1 else 'https://api.mainnet-beta.solana.com'
JUP = 'https://lite-api.jup.ag/swap/v1'
ORDERS = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ'
PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
WSOL = 'So11111111111111111111111111111111111111112'
USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
BUILTIN = {'11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
           'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
           'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'Sysvar1nstructions1111111111111111111111111', 'SysvarRent111111111111111111111111111111111',
           'SysvarC1ock11111111111111111111111111111111', 'AddressLookupTab1e1111111111111111111111111'}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'venues')
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

def http(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', 'user-agent': 'rektbull-tests'})
    for attempt in range(8):  # public endpoints rate-limit: back off and retry
        try:
            time.sleep(0.25)
            return json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(2 ** attempt)
    raise SystemExit(f'{url} kept rate-limiting; pass a private RPC URL')

def rpc(method, params):
    r = http(RPC, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
    return r.get('result')

def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return b'\0' * (len(s) - len(s.lstrip('1'))) + raw

def pda(program, *seeds):
    out = subprocess.run(['solana', 'find-program-derived-address', program, *seeds], check=True, capture_output=True, text=True).stdout
    return out.split()[0]

TRANSIT = pda(ORDERS, 'string:transit')
dumped = set()

def dump(address, folder):
    """Saves one account (JSON) or program (.so); skips the runtime's built-in programs and transit's own accounts."""
    if address in BUILTIN or address in dumped: return
    dumped.add(address)
    v = (rpc('getAccountInfo', [address, {'encoding': 'base64'}]) or {}).get('value')
    if v is None: return  # no account onchain (e.g. a PDA not created yet)
    if v['executable']:
        subprocess.run(['solana', 'program', 'dump', '-u', RPC, address, os.path.join(folder, f'{address}.so')], check=True, stdout=subprocess.DEVNULL)
    else:
        json.dump({'address': address, 'lamports': v['lamports'], 'owner': v['owner'], 'data': v['data'][0]}, open(os.path.join(folder, f'{address}.json'), 'w'))

# ── PumpSwap ──
# Buys only: the sell layout is the buy layout without the two volume accounts, so a buy gives both.
NAMES = {hashlib.sha256(('global:' + n).encode()).digest()[:8]: n for n in ('buy', 'buy_exact_quote_in')}

def writable_keys(tx):
    """The transaction's writable accounts, from its message header and loaded addresses."""
    m = tx['transaction']['message']; h = m['header']; keys = m['accountKeys']
    signed, ro_signed, ro_unsigned = h['numRequiredSignatures'], h['numReadonlySignedAccounts'], h['numReadonlyUnsignedAccounts']
    out = {k for i, k in enumerate(keys) if (i < signed - ro_signed) or (signed <= i < len(keys) - ro_unsigned)}
    return out | set((tx['meta'].get('loadedAddresses') or {}).get('writable', []))

def find_pumpswap():
    for s in rpc('getSignaturesForAddress', [PUMP_AMM, {'limit': 1000}]) or []:
        if s['err']: continue
        tx = rpc('getTransaction', [s['signature'], {'encoding': 'json', 'maxSupportedTransactionVersion': 0}])
        if not tx: continue
        la = tx['meta'].get('loadedAddresses') or {}
        keys = tx['transaction']['message']['accountKeys'] + la.get('writable', []) + la.get('readonly', [])
        ixs = list(tx['transaction']['message']['instructions'])
        for inner in tx['meta'].get('innerInstructions') or []: ixs += inner['instructions']
        for ix in ixs:
            name = NAMES.get(b58d(ix['data'])[:8]) if keys[ix['programIdIndex']] == PUMP_AMM else None
            if not name: continue
            acc = [keys[i] for i in ix['accounts']]
            if acc[4] != WSOL: continue  # pools quoted in wrapped SOL only
            user = acc[1]
            wr = writable_keys(tx)
            return {'instruction': name, 'accounts': acc, 'writable': [k in wr for k in acc], 'user': user,
                    'user_volume_accumulator': pda(PUMP_AMM, 'string:user_volume_accumulator', f'pubkey:{user}'),
                    'base_token_program': acc[11], 'signature': s['signature'], 'slot': tx['slot'], 'block_time': tx['blockTime']}
    raise SystemExit('no PumpSwap trade on a wrapped-SOL pool in the last 1,000 transactions; run again')

# ── Jupiter ──
# Classic pool exchanges only: a copy of their accounts is their whole state. (Proprietary AMMs such as ZeroFi or
# BisonFi have their prices pushed onchain every slot, so a copy goes stale at once and their swaps fail on it.)
DEXES = urllib.parse.quote('Whirlpool,Raydium CLMM,Raydium,Meteora DLMM')
def jupiter(input_mint, output_mint, amount):
    q = http(f'{JUP}/quote?inputMint={input_mint}&outputMint={output_mint}&amount={amount}&slippageBps=300&onlyDirectRoutes=true&maxAccounts=30&dexes=' + DEXES)
    if 'routePlan' not in q: raise SystemExit(f'Jupiter quote failed: {q}')
    r = http(f'{JUP}/swap-instructions', {'quoteResponse': q, 'userPublicKey': TRANSIT, 'wrapAndUnwrapSol': False, 'useSharedAccounts': False})
    if 'swapInstruction' not in r: raise SystemExit(f'Jupiter swap-instructions failed: {r}')
    return {'quote': {k: q[k] for k in ('inAmount', 'outAmount', 'otherAmountThreshold', 'slippageBps')},
            'route': [p['swapInfo']['label'] for p in q['routePlan']], 'swap': r['swapInstruction'],
            'lookup_tables': r.get('addressLookupTableAddresses', [])}

os.makedirs(os.path.join(OUT, 'accounts'), exist_ok=True)
acc_dir = os.path.join(OUT, 'accounts')
dumped.add(TRANSIT)
pumpswap = find_pumpswap()
for i, a in enumerate(pumpswap['accounts']):
    if a in (pumpswap['user'], pumpswap['user_volume_accumulator']) or i in (5, 6): continue  # the trader's own accounts
    dump(a, acc_dir)
print('PumpSwap pool', pumpswap['accounts'][0], 'coin', pumpswap['accounts'][3], 'from', pumpswap['instruction'])

slot = rpc('getSlot', [])
buy = jupiter(WSOL, USDC, 99_000_000)                           # 0.099 wrapped SOL (0.1 less the 1% fee) to USDC
sell = jupiter(USDC, WSOL, int(int(buy['quote']['outAmount']) * 0.98))  # most of that USDC back to wrapped SOL
for j in (buy, sell):
    for a in j['swap']['accounts']: dump(a['pubkey'], acc_dir)
    dump(j['swap']['programId'], acc_dir)
    # The lookup tables only shorten the transaction: every account they hold for this swap is already in its list.
    for t in j['lookup_tables']: dump(t, acc_dir)
    print('Jupiter', j['route'], j['quote'])

json.dump({'transit': TRANSIT, 'slot': slot, 'block_time': int(time.time()), 'pumpswap': pumpswap, 'jupiter_buy': buy, 'jupiter_sell': sell},
          open(os.path.join(OUT, 'venues.json'), 'w'), indent=1)
print('saved', len(dumped), 'accounts and programs to', OUT)
