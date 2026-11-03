# Refund metrics: data and charts (`demo.ipynb`)

How the refund dashboard metrics from Tableau were rebuilt in Python/Plotly inside [demo.ipynb](demo.ipynb): what the data is, how each metric is calculated, and the choices made along the way.

## 1. Data

**Source:** ClickHouse, one query (cell `query` in the notebook). It is the same feed as the Tableau refunds dashboard, for two products:

| product | database | rows (pull of 2026-11-03) |
|---|---|---|
| `jobescape` | `jobescape.*` | ~996k |
| `7art` | `sevenart.*` | ~24k |

Period: transactions from **2025-01-01** to today. A pull returns about **1.02M rows**.

### Row types (`type`)

The result is a `UNION ALL` of three row kinds, so **one order can appear on several rows**:

| `type` | rows | what it is | `date` = | `amount` = |
|---|---|---|---|---|
| `transaction` | ~954k | one settled payment (`$1 first_verification` excluded) | payment time | payment amount, USD |
| `refund` | ~46k | one refund per order (all refund parts merged) | first refund time | refunded amount, USD, capped at the payment |
| `refund_support` | ~20k | **copy** of a `refund` row that has a `support_agent_email` | first refund time | same as the refund |

`refund_support` rows duplicate refunds. Any sum over all rows without filtering `type` counts agent-handled refunds twice.

### How the query builds it

- **Payments:** `jobescape_all_payments_normalized` + `sevenart_payments`, `status = 'settled'`. Amounts are converted to USD with `general.exchange_rate` on the payment date. `mid` is normalised for Jobescape (e.g. `adyen_us_solid`, `adyen_uae`, `esquire_old` / `esquire_new`).
- **Refunds:** `jobescape_refunds` + `sevenart_refunds`, collapsed to **one row per order**:
  - amount = the sum of distinct (amount, status) parts, so webhook retries are dropped but real two-part refunds are kept
  - date = the first refund
  - status = the final state (`full_refund` > `partial_refund` > `settled` > `void`)
  - other fields = the first non-empty value
  - converted to USD on the refund date and capped at the payment amount
- **Funnel attributes** (`age`, `gender`, `subscription_plan`, `utm_*`): taken from the user's **first** `pr_funnel_subscribe` event. 7art gender and utm_source are normalised the same way as Jobescape. Payments with no subscribe event get `gender = 'other'` and empty funnel fields.

### Main columns

| column | notes |
|---|---|
| `order_id`, `customer_account_id`, `subscription_id` | ids |
| `date`, `amount` | see row types above; amount in USD |
| `type` | `transaction` / `refund` / `refund_support` |
| `product` | `jobescape` / `7art` |
| `payment_type` | `first`, `recurring`, `upsell`, `restore` |
| `payment_method`, `channel`, `mid`, `issuing_bank`, `card_brand` | payment rail |
| `geo_country` | country code (~235 values) |
| `subscription_plan` | `4Week`, `12Week`, `1Week`, `3Month`, … (~15 values) |
| `utm_source` | `facebook`, `google`, `tiktok`, `axon`, `landing`, `other` |
| `age` | bands such as `18-24` … `55+`; several band schemes mixed |
| `gender` | `male`, `female`, `other`, `prefer not to say`, … |
| `refund_type` | `support_request`, `pointai`, `Mastercard Alert`, `Visa CDRN`, `Visa RDR`, `Ethoca`, `paypal_dispute`, … (`transaction` on payment rows) |
| `refund_reason` | free text, ~870 values; `dispute`, `upsell_24_hour`, `paypal`, `completed_modules`, `eu_user`, … |
| `support_agent_email` | agent who handled the refund (~26 agents); empty if none |

## 2. What was built

Every Tableau snippet in the notebook now has an interactive Plotly chart under it: **metric on the y axis, `Date` on the x axis**. The Tableau formulas are kept as markdown code blocks for reference. They are not Python, so before this change "Run All" failed on them.

### Controls on every chart

| control | values |
|---|---|
| **Time step** | day / week / month / quarter / year (default week) |
| **Breakdown** | general (none), subscription (`subscription_plan`), geo (`geo_country`), `utm_source`, `payment_type`, `mid`, `age`, `gender` |
| **Period** | range slider by day; drag both ends to set the window |
| **product** | multi-select with **All** (default) |
| **payment_type** | multi-select with **All** (default) |
| **Metric** | only on the Refund Support chart: dispute / eu_user / completed_modules |

The date follows Tableau's `Date = DATETRUNC([Time step], [date], 'monday')`: dates are truncated to the start of the period, and weeks start on Monday.

Hovering a point shows the rate with its numerator and denominator, e.g. `8.79% (12,345 / 140,432)`.

### Metrics

| chart | formula (Python version) | segment |
|---|---|---|
| **Refund Rate (Sum)** `refund_rate` | Σ amount (`refund`) / Σ amount (`transaction`) | chosen breakdown |
| **Refund Rate (Count)** `refund_rate_count` | countd order_id (`refund`) / countd order_id (`transaction`) | chosen breakdown |
| **Refund Support** `refund_rate_dispute` | Σ refund amount where reason = `dispute` / Σ refund amount where refund_type = `support_request` | chosen breakdown |
| `refund_rate_eu_user` | same, reason = `eu_user` | chosen breakdown |
| `refund_rate_cm` | same, reason = `completed_modules` | chosen breakdown |
| **Refund Support Agent** `agent_refund_share` | countd order_id (`refund_support`, this agent) / countd order_id (`refund` & `support_request`) in that period | agent |
| **Support Agent** `support_refund_rate_agent` | Σ refund amount (`support_request` + `pointai`) for this agent / the same total over all agents in that period | agent |
| **Support by Reason** `support_refund_rate_reason` | Σ refund amount (`support_request` + `pointai`) for this reason / the same total over all reasons in that period | `refund_reason_cleaned` |

`refund_reason_cleaned` follows the Tableau calc:
- `refund_type = 'pointai'` → `pointai`
- `24h upsell` / `upsell_24_hour` → `24h upsell`
- `eu` / `eu_user` → `eu_user`
- anything else → lower-cased reason

## 3. Choices and differences from Tableau

1. **Support metrics use `type = 'refund'` rows only.** The Tableau formulas don't filter `type`, so the `refund_support` copies would count agent-handled refunds twice.
2. **"TOTAL, table down" is read as a share within each period.** For the agent and reason charts, the denominator is that period's total support_request + pointai refunds, so the segments of one date add up to 100%. The numerator is limited to the same refund types.
3. **Top 7 segments + "Other segments".** Each breakdown shows its 7 largest segments, picked again whenever the filters change; the rest go into one gray line. This keeps geo (~235 countries) and agents (~26) readable. "Other segments" is a real aggregate (Σ numerator / Σ denominator of the rest), not an average of rates.
4. **Blanks become `(none)`.** Empty or missing breakdown values, agent emails and refund reasons are shown as a `(none)` segment. In the agent charts, `(none)` is mostly pointai and unassigned refunds.
5. **Agent share is below 100%** (about 94–97%), because some `support_request` refunds have no agent email.
6. **The last period is incomplete.** Data runs to today, so the current week or month looks off until it ends. The same goes for the first and last period when a Period slider handle sits mid-week or mid-month.
7. **Refunds are dated by refund time and transactions by payment time.** This matches the dashboard: a period's refund rate is "refunds issued in the period / revenue taken in the period", not a cohort rate.

## 4. How to use

1. Run the setup and query cells (the ClickHouse fetch takes a minute or two).
2. Run **Plot helpers**. It builds `d`, a copy of `df` with derived columns, and defines `METRICS`, `compute()`, `plot_metric()` and `explore()`.
3. Run any `explore(...)` cell and use the controls.

Without widgets:

```python
compute('refund_rate', time_step='month', breakdown='geo',
        date_range=(pd.Timestamp('2026-06-01'), pd.Timestamp('2026-09-30')),
        products=['7art'], payment_types=['All'])        # -> DataFrame: Date, segment, num, den, value

plot_metric('refund_rate_count', time_step='week', breakdown='mid').show()
```

- **Add a metric:** add an entry to `METRICS`, with `num` / `den` as `(column, 'sum' | 'nunique')`, an optional fixed `segment` column, and `total=True` for share-of-period metrics.
- **Add a filter:** add a line to `FILTERS`, e.g. `'countries': 'geo_country'`.
