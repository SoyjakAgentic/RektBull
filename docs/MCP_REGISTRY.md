# Listing RektBull in the MCP Registry (after launch)

The [official MCP Registry](https://registry.modelcontextprotocol.io) is the
public list of MCP servers that AI apps and directories read from. Listing
RektBull there lets people find its MCP server (`https://rektbull.com/mcp`)
without knowing the address.

**When:** after launch, once `https://rektbull.com/mcp` answers in public. The
registry requires a public URL, so it can't be done before.
**Who:** you run the commands and add the DNS record (you own the domain, and
you should be the only one holding the key). Claude walks you through each step
and checks the record and the listing.
**Time:** about 30 minutes, most of it waiting for DNS.
**Cost:** free.

The registry was **in preview** when this was written (November 2026): its
docs warn of breaking changes. If a command below fails in a way this guide
doesn't cover, check the
[publishing guide](https://github.com/modelcontextprotocol/registry/tree/main/docs/modelcontextprotocol-io)
or ask Claude to read the current docs.

## What gets published

The repo's [`server.json`](../server.json):

- **Name:** `com.rektbull/mcp`. A name starting `com.rektbull/` can only be
  published by whoever proves control of `rektbull.com`.
- **Address:** `https://rektbull.com/mcp` (Streamable HTTP).
- **Version:** `1.0.0`.
- **Description:** 100 characters at most; the registry refuses longer ones.

## Before you start

- [ ] `https://rektbull.com/mcp` answers. The smoke test in
      [LAUNCH_PLAN.md](LAUNCH_PLAN.md) section 5D covers it; Claude can
      re-check it.
- [ ] You can add DNS records for `rektbull.com` (where its other records
      live).
- [ ] A computer with a terminal (macOS or Linux; Windows works too, with the
      PowerShell install below), and a copy of the repo for `server.json`.

## Step 1. Install the publishing tool

macOS with Homebrew:

```bash
brew install mcp-publisher
```

Or on macOS or Linux without Homebrew:

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Windows (PowerShell), then move `mcp-publisher.exe` into a folder on your PATH:

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

Check it works: `mcp-publisher --help`.

## Step 2. Make the key that proves you own rektbull.com

This makes a key pair: a private key (stays with you) and a public key (goes
in DNS). It needs OpenSSL 3. On a Mac, the built-in one can't do this, so
first run `brew install openssl@3` and use
`/opt/homebrew/opt/openssl@3/bin/openssl` (Apple Silicon) or
`/usr/local/opt/openssl@3/bin/openssl` (Intel) wherever it says `openssl`.

Do this in a folder **outside the repo**, so the key can never be committed:

```bash
mkdir -p ~/rektbull-mcp-key && cd ~/rektbull-mcp-key
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
```

The last line prints the value for the DNS record, like
`v=MCPv1; k=ed25519; p=AbC123…=`.

**Keep `key.pem` safe.** It's what lets someone publish under
`com.rektbull/`. Put it in your password manager (as a secure note or an
attached file), and never paste it into a chat, an issue, the repo, or the
server. Claude never needs it. If you lose it, you make a new one and replace
the DNS record (step 6); nothing else breaks.

## Step 3. Add the DNS record

At your DNS provider, add a **new TXT record**:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name / host | `rektbull.com` itself: usually written `@` or left blank. **Not** `_mcp-auth` or any other sub-name; the registry only looks at the root. |
| Value | The line from step 2: `v=MCPv1; k=ed25519; p=…` |
| TTL | The default (or 300 seconds) |

`rektbull.com` already has a TXT record for email (`v=spf1 …`). **Add this as a
separate record; don't edit or replace the SPF one.** A domain can have several
TXT records.

Wait a few minutes, then check it's visible:

```bash
dig TXT rektbull.com +short
```

The answer should include the `"v=MCPv1; k=ed25519; p=…"` line (and the SPF
line). **Tell Claude when it's added**: Claude will check it from outside and
confirm it matches.

## Step 4. Log in to the registry with the key

In the key's folder:

```bash
cd ~/rektbull-mcp-key
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain "rektbull.com" --private-key "${PRIVATE_KEY}"
```

The registry checks your DNS record against the key. It prints an
`Expected proof record:` line: if login fails, compare that with what
`dig TXT rektbull.com +short` shows.

## Step 5. Check, then publish

From the repo folder (where `server.json` is):

```bash
mcp-publisher validate
mcp-publisher publish
```

You should see `✓ Successfully published` and
`✓ Server com.rektbull/mcp version 1.0.0`.

Check the listing:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.rektbull/mcp"
```

The answer should contain `"name":"com.rektbull/mcp"`. **Tell Claude it's
published**: Claude will check the listing and that its address answers.

## Step 6. Later: updates and a new key

- **Changing the listing** (description, a new address): Claude edits
  `server.json` in a PR and raises its `version` (for example `1.0.1`). After
  it's merged, run steps 4 and 5 again from the updated repo.
- **A new key** (the old one lost or exposed): make one (step 2), add its DNS
  record, **and delete the old `v=MCPv1` record**, since the registry tries an
  old record first and login then fails. Then log in (step 4) and publish.
- **Nothing to renew:** the listing stays until it's changed. Keep the DNS
  record in place for the next update.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| A signature error at login | The record isn't on the root of `rektbull.com`, or hasn't reached the registry yet | Check the record's name is `@` or blank, wait 10 minutes, and try again |
| The record shows in `dig`, but login still fails | Another `v=MCPv1` record is left over | Delete every `v=MCPv1` record except the current one |
| `Invalid or expired Registry JWT token` | The login has expired | Run step 4 again |
| `You do not have permission to publish this server` | The name in `server.json` doesn't match the domain you logged in with | It must start `com.rektbull/`, and the login must be for `rektbull.com` |
| A validation error about the description | It's over 100 characters | Ask Claude to shorten it |
| The address is already used by another server | Each address can belong to one listing only | Tell Claude: someone has listed RektBull's address under another name |

## Afterwards

Once it's listed, Claude can check other directories that take MCP servers
(Claude's and Cursor's, for example) and prepare whatever each one asks for.
That's a separate step, done only with your go-ahead.
