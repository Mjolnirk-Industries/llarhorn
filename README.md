# llarhorn

**llarhorn** is a [Pi](https://github.com/earendil-works/pi) extension that balances
several **named** OpenCode Go API keys. When the active key hits its rate limit, the
extension verifies the limit against the OpenCode Go usage endpoint and rotates to the
next eligible account. A persistent status indicator always shows which account is in use.

The name comes from **Gjallarhorn**, the horn of Heimdall in Norse mythology: it sounds
the alarm when something is wrong — here, when your active key runs out of quota.

## Install

From a local checkout:

```bash
pi --extension ./dist/index.js
```

Build first with `npm install && npm run build`, or load the TypeScript source directly
during development (Pi compiles it with jiti):

```bash
pi --extension ./src/index.ts
```

Install from npm (once published):

```bash
pi install npm:llarhorn
```

## Setup

Keys are stored in `~/.pi/agent/llarhorn-keys.json` and are referenced by name, so
switching accounts never depends on ordering. Add one entry per account:

```
/llarhorn add heimdall sk-xxxxxxxxxxxxxxxx
/llarhorn add baldur   sk-yyyyyyyyyyyyyyyy
```

The first key added becomes active immediately. Switch at any time by name:

```
/llarhorn use baldur
```

Key material is never printed in full. Status output shows names and a masked suffix
(for example `heimdall (••••cdef)`).

## How it works

Pi resolves credentials in this order: a runtime `--api-key`, a stored `auth.json`
credential, an `apiKey` from `models.json`, then the provider's environment variables.
llarhorn registers the active key as a **runtime override**, which takes priority over
`OPENCODE_API_KEY` and `auth.json`.

Recovery is reactive:

1. **Verified quota exhaustion** — when `opencode-go` returns HTTP 429, llarhorn asks
   `https://opencode.ai/zen/go/v1/usage` with the active key (10 s timeout). If a usage
   window reports `rate-limited`, that key is quota-blocked until the reported reset and
   the next eligible key is activated.
2. **Unverified / transient limits** — when the usage endpoint is unavailable, times out,
   or reports no rate-limited window, llarhorn preserves the transient behavior: the
   current key is put on the configured cooldown and the next eligible key is activated.

Pi's built-in auto-retry then uses the new key on the next request. A rotation caused by
the provider-response hook is deduplicated, so the matching message-end error cannot
rotate a second time.

## Eligibility policy

- Quota-blocked keys are **never** selected automatically.
- Non-cooling keys are preferred.
- When every other key is cooling, the next one's cooldown is cleared instead of staying
  on an exhausted key.
- When **all** keys are quota-blocked, rotation stops and llarhorn reports the earliest
  reset time.

## Commands

| Command | Description |
|---------|-------------|
| `/llarhorn` or `/llarhorn status` | Show all keys, the active account, cooldowns and quota blocks |
| `/llarhorn add <name> <key>` | Add a named key; the first key becomes active |
| `/llarhorn use <name>` | Switch to a named key and clear its cooldown and quota block |
| `/llarhorn next` | Advance to the next eligible key |
| `/llarhorn rm <name>` | Remove a named key |
| `/llarhorn reset` | Clear all cooldowns and quota blocks |
| `/llarhorn usage` | Fetch OpenCode Go usage for the active key without exposing key material |
| `/llarhorn cooldown [min]` | Set or view the transient cooldown duration in minutes |

## Configuration

`~/.pi/agent/llarhorn-keys.json` is created and maintained with POSIX permissions `0600`
and written atomically (temporary file plus rename). Set `LLARHORN_CONFIG` to override
the path.

```json
{
  "keys": [
    { "name": "heimdall", "key": "sk-xxx" },
    { "name": "baldur", "key": "sk-yyy" }
  ],
  "activeKey": "heimdall",
  "cooldownMinutes": 60,
  "cooldowns": {},
  "quotaBlockedUntil": {}
}
```

### Retry settings

Pair llarhorn with Pi's auto-retry. In `~/.pi/agent/settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

Set `maxRetries` to at least the number of configured keys so every key gets a chance
before Pi gives up.

## Limitations

- **Reactive only.** llarhorn reacts to an HTTP 429. It does not poll usage or check
  limits before a normal request.
- **Shared workspace quota.** OpenCode Go plan limits are tied to the subscription
  workspace; multiple keys from the same workspace may not provide independent quota.
  See the [OpenCode Go documentation](https://opencode.ai/docs/go/).
- **Plaintext storage.** Keys are stored in plaintext in the config file, protected only
  by `0600` file permissions.
- **No auth import.** llarhorn does not import `auth.json`; it reports
  `No keys configured. Use /llarhorn add <name> <key>` instead.
- **Quota-blocked keys are never auto-selected.** A manual `/llarhorn use <name>` clears
  the restrictions on the selected key.

## Roadmap

- **Watchdog stall detection** — detect silent provider stalls (no response or stream
  activity) and rotate to an eligible key, aborting the hung turn. The reference
  implementation ships this; llarhorn v1 keeps rotation strictly reactive.
- Usage pre-checks before a request when a key is close to its limit.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests use the Node.js test runner with `--experimental-strip-types` and focus on the
config store, the rotation eligibility policy, normalisation, and status rendering.

## License

MIT © Mjolnirk-Industries
