"""Pull the refunds feed from ClickHouse and save it, encrypted, as data/refunds.parquet.enc for the UI.

Same query and the same column prep as demo.ipynb ("Plot helpers" cell); the metrics themselves
are computed in the browser (app.js).

The published site only holds the encrypted file. The key lives in data/.key (never committed) and travels
in the access link after '#', which browsers don't send to the server:  <site>/#k=<key>

Usage:
  python export_data.py                 pull from ClickHouse, encrypt with the existing key (the link keeps working)
  python export_data.py --no-pull       re-encrypt the local data/refunds.parquet without querying ClickHouse
  python export_data.py --rotate-key    new key: old links stop working once the new file is published
"""
import argparse
import base64
import json
import os
import secrets
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
PLAIN = DATA / 'refunds.parquet'      # local only (.gitignore)
ENC = DATA / 'refunds.parquet.enc'    # published
KEY = DATA / '.key'                   # local only (.gitignore)
SITE_URL = os.environ.get('SITE_URL', 'https://sergeygerasimov-png.github.io/Support-Dash/')
DAGS_PATH = os.environ.get('DAGS_PATH', '/Users/sgerasimov/Desktop/work_nomad/dags')

# breakdowns + segment columns: blanks become '(none)'
SEGMENT_COLS = ['subscription_plan', 'geo_country', 'utm_source', 'payment_type', 'mid', 'age', 'gender',
                'support_agent_email', 'refund_reason', 'refund_type']
KEEP = ['order_key', 'date', 'amount', 'type', 'product', *SEGMENT_COLS, 'refund_reason_cleaned']


def pull():
    sys.path.insert(0, DAGS_PATH)
    from services.clickhouse import ClickHouseBaseHook

    client = ClickHouseBaseHook()
    try:
        df = client.get_records_as_df((HERE / 'query.sql').read_text())
    finally:
        client.close()

    for col in SEGMENT_COLS + ['product']:
        df[col] = df[col].replace('', np.nan).fillna('(none)').astype(str)

    reason = df['refund_reason'].str.lower()
    df['refund_reason_cleaned'] = np.select(
        [df['refund_type'] == 'pointai', reason.isin(['24h upsell', 'upsell_24_hour']), reason.isin(['eu', 'eu_user'])],
        ['pointai', '24h upsell', 'eu_user'],
        default=reason,
    )

    # order_id is only needed for COUNT DISTINCT: an int key is much smaller to ship to the browser
    df['order_key'] = pd.factorize(df['order_id'])[0].astype('int32')
    date = pd.to_datetime(df['date'])
    if date.dt.tz is not None:
        date = date.dt.tz_localize(None)
    df['date'] = date.astype('datetime64[ms]')
    df['amount'] = df['amount'].astype('float64')

    out = df[KEEP].sort_values('date')
    for col in out.columns:
        if out[col].dtype == object:
            out[col] = out[col].astype('category')

    DATA.mkdir(exist_ok=True)
    out.to_parquet(PLAIN, index=False, compression='zstd')
    (DATA / 'meta.json').write_text(json.dumps({
        'exported_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'rows': len(out),
    }))
    print(f'{len(out):,} rows, {out["date"].min():%Y-%m-%d} .. {out["date"].max():%Y-%m-%d}')


def load_key(rotate):
    if KEY.exists() and not rotate:
        return base64.urlsafe_b64decode(KEY.read_text().strip() + '==')
    key = secrets.token_bytes(32)
    KEY.write_text(base64.urlsafe_b64encode(key).decode().rstrip('='))
    KEY.chmod(0o600)
    print('New key generated: share the new link below, old links stop working.')
    return key


def encrypt(key):
    # file = 12-byte IV + AES-256-GCM ciphertext (tag appended), the layout WebCrypto's decrypt() expects
    iv = secrets.token_bytes(12)
    ENC.write_bytes(iv + AESGCM(key).encrypt(iv, PLAIN.read_bytes(), None))
    print(f'{ENC.relative_to(HERE)} ({ENC.stat().st_size / 1e6:.1f} MB)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-pull', action='store_true', help='encrypt the local parquet without querying ClickHouse')
    ap.add_argument('--rotate-key', action='store_true', help='generate a new key (invalidates old links)')
    args = ap.parse_args()

    if not args.no_pull:
        pull()
    elif not PLAIN.exists():
        sys.exit(f'{PLAIN} not found: run without --no-pull first')
    encrypt(load_key(args.rotate_key))
    print(f'\nAccess link:\n  {SITE_URL}#k={KEY.read_text().strip()}')


if __name__ == '__main__':
    main()
