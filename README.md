# Support refund dashboard

Refund metrics for the support team: refund rate, refund support reasons, agent shares. A static page
(`index.html` + `app.js`) that loads the data into DuckDB in the browser and draws it with Plotly.
Metric definitions: [refund_metrics.md](refund_metrics.md).

## Access

The data in `data/refunds.parquet.enc` is encrypted (AES-256-GCM). The page decrypts it with the key in the
access link, after `#k=`. The part after `#` is never sent to the server, so the repo and the hosted files hold
only ciphertext. Anyone with the full link can open the dashboard, so share it only inside the team.

## Update the data

```bash
python export_data.py              # pull from ClickHouse and encrypt with the current key; the link keeps working
git add data && git commit -m "Update data" && git push
```

`python export_data.py --rotate-key` makes a new key, so old links stop working once it is pushed. Use it when
the link has leaked or someone should lose access, then send the new link it prints.

The key is in `data/.key` and the plain parquet is in `data/refunds.parquet`. Both are git-ignored and must
stay that way.

## Run locally

```bash
./serve.sh             # prints http://127.0.0.1:8050/#k=...
./serve.sh --refresh   # pull fresh data first
```
