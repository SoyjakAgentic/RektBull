/*
 * RektBull inside MetaMask.
 *
 * - onTransaction / onSignature: send the request to RektBull's pre-sign
 *   check and show the answer in MetaMask's own confirmation screen: the
 *   verdict, every finding with its source, what the simulation says would
 *   leave and reach the wallet, and what couldn't be checked. A high or
 *   critical verdict is shown as a warning MetaMask makes the user read
 *   before confirming.
 * - onCronjob (every 30 minutes): new risk monitor alerts become MetaMask
 *   notifications.
 * - onHomePage: whether it's linked, free checks or Safety Pro, latest alerts.
 * - onRpcRequest: only rektbull.com may call it, to link (or unlink) the
 *   user's account. The link token is kept in MetaMask's encrypted Snap
 *   storage. It can only run checks and read alerts.
 *
 * The Snap holds no keys and can't sign or send anything.
 */
import { SeverityLevel } from '@metamask/snaps-sdk';
import { Box, Heading, Text, Bold, Divider, Link, Banner, Section } from '@metamask/snaps-sdk/jsx';

const SITE = 'https://rektbull.com';
const TEST = process.env.SNAP_ENV === 'test';
const TIMEOUT_MS = 8000;
const COLOR = { critical: 'error', high: 'error', medium: 'warning', low: 'success', info: 'muted' };

const getState = async () => (await snap.request({ method: 'snap_manageState', params: { operation: 'get', encrypted: true } })) || {};
const setState = state => snap.request({ method: 'snap_manageState', params: { operation: 'update', newState: state, encrypted: true } });

async function api(path, { method = 'GET', body } = {}) {
  const { token, apiBase = SITE } = await getState();
  if (!token) return { status: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiBase + path, {
      method, signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: -1, error: err.name === 'AbortError' ? 'RektBull took too long to answer.' : 'RektBull couldn\'t be reached.' };
  } finally { clearTimeout(timer); }
}

const chainNumber = caip => { const n = Number(String(caip || '').split(':')[1]); return Number.isFinite(n) ? n : null; };

/* ── what MetaMask shows ── */
function notChecked(reason, linkText) {
  return (
    <Box>
      <Heading>RektBull</Heading>
      <Text color="muted">Not checked: {reason}</Text>
      {linkText ? <Text><Link href={`${SITE}/extension`}>{linkText}</Link></Text> : null}
    </Box>
  );
}

function verdictView(r) {
  const findings = (r.findings || []).filter(f => f.severity !== 'info').slice(0, 6);
  const changes = r.simulation?.changes || [];
  return (
    <Box>
      {r.verdict === 'critical' || r.verdict === 'high'
        ? <Banner title={`RektBull: ${r.verdict} risk`} severity="danger"><Text>{r.summary}</Text></Banner>
        : <Heading>{`RektBull: ${r.verdict === 'low' ? 'no known risk' : `${r.verdict} risk`}`}</Heading>}
      {r.verdict === 'critical' || r.verdict === 'high' ? null : <Text>{r.summary}</Text>}
      {findings.map(f => (
        <Section>
          <Text color={COLOR[f.severity] || 'default'}><Bold>{`${f.severity.toUpperCase()}: ${f.title}`}</Bold></Text>
          <Text>{f.detail}</Text>
          <Text color="muted" size="sm">{`Source: ${f.source}`}</Text>
        </Section>
      ))}
      {changes.length ? <Divider /> : null}
      {changes.length ? <Text><Bold>What the simulation shows</Bold></Text> : null}
      {changes.map(c => <Text>{`${c.direction === 'out' ? 'Leaves' : 'Arrives in'} your wallet: ${c.amount ?? c.raw} ${c.symbol || c.token}${c.usd ? ` (about $${c.usd.toLocaleString()})` : ''}`}</Text>)}
      {(r.not_checked || []).length ? <Text color="muted" size="sm">{`Not checked: ${r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}`}</Text> : null}
      <Text color="muted" size="sm">{r.note}</Text>
    </Box>
  );
}

/** Asks RektBull and turns the answer into what MetaMask shows. */
async function check(request) {
  const r = await api('/v1/presign/check', { method: 'POST', body: request });
  if (r.status === 0) return { content: notChecked('this Snap isn\'t linked to a RektBull account yet.', 'Link it on rektbull.com') };
  if (r.status === 200) {
    const severe = r.body.verdict === 'critical' || r.body.verdict === 'high';
    return { content: verdictView(r.body), ...(severe ? { severity: SeverityLevel.Critical } : {}) };
  }
  if (r.status === 401) { await setState({ ...(await getState()), token: null }); return { content: notChecked('the link to your RektBull account ended.', 'Link it again') }; }
  if (r.status === 402) return { content: notChecked('this month\'s free checks are used up. Safety Pro checks every request.', null) };
  return { content: notChecked(r.error || r.body?.message || `RektBull answered ${r.status}.`, null) };
}

export const onTransaction = async ({ transaction, chainId, transactionOrigin }) => check({
  method: 'eth_sendTransaction', params: [transaction], chain_id: chainNumber(chainId),
  from: transaction?.from || null, origin: transactionOrigin || null,
});

export const onSignature = async ({ signature, signatureOrigin }) => {
  const { from, data, signatureMethod } = signature || {};
  const params = signatureMethod === 'personal_sign' ? [data, from]
    : signatureMethod === 'eth_signTypedData' ? [data, from]
      : [from, data]; // eth_sign, eth_signTypedData_v3, eth_signTypedData_v4
  const chainId = typeof data === 'object' && data?.domain?.chainId ? Number(data.domain.chainId) : null;
  return check({ method: signatureMethod, params, chain_id: chainId, from: from || null, origin: signatureOrigin || null });
};

/* ── alerts as MetaMask notifications ── */
export const onCronjob = async ({ request }) => {
  if (request.method !== 'checkAlerts') return null;
  const r = await api('/v1/monitor/alerts?unread=1');
  if (r.status !== 200) return null;
  const state = await getState();
  const seen = Number(state.lastAlertId || 0);
  const fresh = (r.body.alerts || []).filter(a => Number(a.id) > seen).sort((a, b) => Number(a.id) - Number(b.id));
  for (const a of fresh.slice(-5)) {
    await snap.request({ method: 'snap_notify', params: { type: 'inApp', message: `RektBull ${a.severity}: ${a.title}`.slice(0, 500) } });
    if (a.severity === 'critical') await snap.request({ method: 'snap_notify', params: { type: 'native', message: `RektBull: critical alert`.slice(0, 50) } });
  }
  if (fresh.length) await setState({ ...state, lastAlertId: Math.max(seen, ...fresh.map(a => Number(a.id))) });
  return { notified: Math.min(fresh.length, 5) };
};

/* ── home page ── */
export const onHomePage = async () => {
  const { token } = await getState();
  if (!token) {
    return { content: (
      <Box>
        <Heading>RektBull</Heading>
        <Text>Not linked yet. Link this Snap to your RektBull account so it can check transactions and signatures before you confirm them.</Text>
        <Text><Link href={`${SITE}/extension`}>Link on rektbull.com</Link></Text>
      </Box>
    ) };
  }
  const [me, alerts] = await Promise.all([api('/v1/me'), api('/v1/monitor/alerts?unread=1')]);
  if (me.status !== 200) return { content: notChecked(me.status === 401 ? 'the link to your account ended.' : 'RektBull couldn\'t be reached.', 'Open rektbull.com') };
  const pro = (me.body.passes || []).find(p => new Date(p.starts_at) <= new Date());
  const list = alerts.status === 200 ? alerts.body.alerts : [];
  return { content: (
    <Box>
      <Heading>RektBull</Heading>
      <Text>{`Checking requests for ${me.body.account.wallet.slice(0, 6)}…${me.body.account.wallet.slice(-4)}.`}</Text>
      <Text>{pro ? `Safety Pro until ${new Date(pro.ends_at).toISOString().slice(0, 10)}.` : `${me.body.points?.left ?? 0} of ${me.body.points?.allowance ?? 0} free checks left this month.`}</Text>
      <Divider />
      <Text><Bold>{list.length ? `${list.length} new alert${list.length === 1 ? '' : 's'}` : 'No new alerts'}</Bold></Text>
      {list.slice(0, 5).map(a => <Text color={COLOR[a.severity] || 'default'}>{a.title}</Text>)}
      <Text><Link href={`${SITE}/safety#monitor-card`}>Open the risk monitor</Link></Text>
    </Box>
  ) };
};

/* ── linking, from rektbull.com only ── */
export const onRpcRequest = async ({ origin, request }) => {
  if (origin !== SITE) throw new Error('Only rektbull.com can link this Snap.');
  const params = request.params || {};
  if (request.method === 'link') {
    if (typeof params.token !== 'string' || params.token.length < 20) throw new Error('A RektBull link token is needed.');
    // The test build may be pointed at a local test server; the published build only ever talks to rektbull.com.
    const apiBase = TEST && typeof params.apiBase === 'string' ? params.apiBase : SITE;
    await setState({ ...(await getState()), token: params.token, apiBase });
    const me = await api('/v1/me');
    if (me.status !== 200) { await setState({ ...(await getState()), token: null }); throw new Error('RektBull didn\'t accept the link.'); }
    return { linked: true, wallet: me.body.account.wallet };
  }
  if (request.method === 'status') return { linked: !!(await getState()).token };
  if (request.method === 'unlink') { await setState({}); return { linked: false }; }
  throw new Error(`Unknown method ${request.method}`);
};
