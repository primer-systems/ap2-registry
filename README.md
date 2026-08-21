# AP2 Registry

Intent Mandate registry for AP2-compliant agent commerce, backing the Primer Agent Manifold.

Live at **[ap2.primer.systems](https://ap2.primer.systems)**.

An *Intent Mandate* is a signed declaration of what an autonomous agent is authorised to do —
which wallet it acts through, which networks it may transact on, and what spending limits apply.
This service stores those mandates and makes them retrievable by mandate ID or agent ID.

## API

Base URL: `https://ap2.primer.systems`

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/mandates` | `POST` | Store or replace a mandate |
| `/api/mandates?id={uuid}` | `GET` | Retrieve a single mandate by ID |
| `/api/mandates?agent_id={id}` | `GET` | Retrieve all mandates for an agent, newest first |

### Storing a mandate

```bash
curl -X POST https://ap2.primer.systems/api/mandates \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "IntentMandate",
    "agent": { "id": "ABC123", "name": "Example Agent" },
    "wallet": { "address": "0x0000000000000000000000000000000000000000" },
    "authorization": {
      "policyName": "daily-spend",
      "networks": ["eip155:8453"],
      "limits": { "dailyLimit": 1000 }
    }
  }'
```

Returns `201` with the mandate `id` and a shareable `url`.

### Replacing a mandate

A mandate belongs to the wallet that signed it. Replacing one requires a request carrying that
wallet's signature.

| Case | Response |
| --- | --- |
| New `id` | `201` created |
| Existing `id`, same signer | `200` updated |
| Existing `id`, different or missing signer | `403 SIGNER_MISMATCH` |
| Stored record is unsigned | `403 SIGNER_MISMATCH` |

MultiClaw issues a fresh UUID per mandate, so commissioning takes the `201` path.

### Validation

| Field | Rule |
| --- | --- |
| `type` | Must equal `IntentMandate` |
| `agent.id` | 3–8 uppercase alphanumerics (`^[A-Z0-9]{3,8}$`), required |
| `wallet.address` | Ethereum address (`0x` + 40 hex) if present |
| `signature.signer` | Ethereum address if present |
| `authorization.networks` | Array of CAIP-2 (`eip155:<chainId>`) or a supported network name |
| `authorization.limits.dailyLimit` | Non-negative number below 10^15 |
| payload | 50 KB maximum |

Errors return a JSON body with `error` and a machine-readable `code`
(`INVALID_MANDATE`, `INVALID_AGENT_ID`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, …).

## Agent identity

Agents are identified by **`agent.id`** — a short handle such as `ABC123`, issued by MultiClaw.
It is the value this registry stores, indexes and accepts in queries.

## Architecture

- **Frontend** — static HTML/CSS in `public/`. `mandate.html` renders a mandate and verifies its
  signature client-side using ethers.js, vendored to `public/js/` so the page satisfies a
  `script-src 'self'` Content-Security-Policy.
- **API** — a single Vercel serverless function, `api/mandates.js`.
- **Storage** — Supabase, table `mandates`, indexed on `agent_id`.

## Configuration

The API requires two environment variables:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key, server-side only |

## Deployment

Pushes to `main` deploy to Vercel via `.github/workflows/deploy.yml`, which expects the repository
secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.

## License

MIT — see [LICENSE](LICENSE).
