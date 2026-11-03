-- Transactions + refunds feed for the refunds dashboard: Jobescape + 7art (updated 2026-10-14).
-- Same columns as the dashboard query, plus `product` at the end ('jobescape' / '7art').
--   * one refund row per order_id (see `refunds`)
--   * refunds converted to USD and capped at the payment amount
--   * transactions taken straight from payments (one row per payment)
--   * funnel attributes: first pr_funnel_subscribe per user
--   * product by database: 'jobescape' = everything in the jobescape database, '7art' = everything in the sevenart database
--   * $1 first_verification charges excluded
--   * FIX 2026-11-03: jobescape.exchange_rate -> general.exchange_rate (2 places: `pay` and `refund_out`)

WITH refund_rows AS (
    SELECT payment_id, refund_id, refund_amount, upper(refund_currency) AS refund_currency, refund_reason, refund_type,
           lower(refund_status) AS refund_status, refund_created_at, support_agent_email, arn
    FROM jobescape.jobescape_refunds
    UNION ALL
    SELECT payment_id, refund_id, refund_amount, upper(refund_currency) AS refund_currency, refund_reason, refund_type,
           lower(refund_status) AS refund_status, refund_created_at, support_agent_email, arn
    FROM sevenart.sevenart_refunds FINAL
),

-- One row per order.
-- The same refund often arrives several times (webhook retries, a copy with and without arn, a second type label),
-- but some orders are really refunded in 2 parts (e.g. 19.48 partial + 19.47 full of 38.95).
-- Amount: each distinct (amount, status) is one refund part; the parts are added up (capped at the payment later).
-- Date: the first refund. Status: the final state (full_refund > partial_refund > settled > void).
-- Other fields: first non-empty value, earliest row first (ties: the row with arn).
refunds AS (
    SELECT
        payment_id AS order_id,
        arraySum(arrayMap(x -> x.1, arrayDistinct(groupArray((refund_amount, part_status))))) AS refund_amount_minor,
        min(part_created_at) AS refund_created_at,
        argMax(part_status, multiIf(part_status = 'full_refund', 4, part_status = 'partial_refund', 3, part_status = 'settled', 2, 1)) AS refund_status,
        argMinIf(refund_id, rnk, refund_id != '') AS refund_id,
        argMinIf(refund_type, rnk, refund_type != '') AS refund_type,
        argMinIf(refund_reason, rnk, refund_reason != '') AS refund_reason,
        argMinIf(support_agent_email, rnk, support_agent_email != '') AS support_agent_email,
        argMinIf(refund_currency, rnk, refund_currency != '') AS refund_currency
    FROM
    (
        SELECT
            *,
            refund_status AS part_status,
            refund_created_at AS part_created_at,
            (refund_created_at, arn = '', refund_id) AS rnk
        FROM refund_rows
    )
    GROUP BY payment_id
),

pay_raw AS (
    SELECT
        order_id,
        user_id,
        amount AS amount_minor,
        upper(currency) AS currency,
        created_at AS transaction_date,  -- settle_datetime always equals created_at
        payment_type,
        payment_method,
        channel,
        multiIf(
            channel = 'solidgate' AND mid IN ('d4d7b345-bf19-453a-acdc-8ea68a5d4c44', '01KMFGBBWW8RDNQJV20QPM8MMN'), 'adyen_us_solid',
            channel = 'primer' AND lower(mid) = 'adyen_us', 'adyen_us',
            channel IN ('primer', 'adyen') AND mid = 'adyen', 'adyen_uae',
            channel = 'solidgate' AND mid = 'de185c91-6045-4190-babc-42558400cb92', 'esquire_old',
            channel = 'solidgate' AND mid IN ('ed141bc8-5fe6-40bd-b501-9d9d3c678689', '01KMFGBN6Y4ZYG1595Q39ATB5N'), 'esquire_new',
            mid
        ) AS mid,
        issuing_bank,
        lower(card_brand) AS card_brand,
        subscription_cohort_date AS cohort_date,
        bin,
        country_code,
        subscription_id,
        'jobescape' AS source
    FROM jobescape.jobescape_all_payments_normalized
    WHERE status = 'settled'
      AND payment_type != 'first_verification'
      AND toDate(created_at) >= '2025-01-01'

    UNION ALL

    SELECT
        payment_id AS order_id,
        user_id,
        amount AS amount_minor,
        upper(currency) AS currency,
        created_at AS transaction_date,
        payment_type,
        payment_method,
        channel,
        mid,
        issuing_bank,
        lower(card_brand) AS card_brand,
        subscription_cohort_date AS cohort_date,
        bin,
        country_code,
        subscription_id,
        'sevenart' AS source
    FROM sevenart.sevenart_payments FINAL
    WHERE status = 'settled'
      AND toDate(created_at) >= '2025-01-01'
),

pay AS (
    SELECT
        p.*,
        p.amount_minor / 100 * ex.exchange_rate AS amount
    FROM pay_raw p
    LEFT JOIN general.exchange_rate ex
        ON ex.date = toDate(p.transaction_date)
        AND ex.currency = p.currency
),

funnel AS (
    SELECT
        source, user_id, age, gender, subscription_plan, utm_source,
        utm_campaign, utm_adset, utm_adgroupid, utm_ad, utm_keyword
    FROM
    (
        SELECT
            'jobescape' AS source,
            user_id,
            timestamp,
            age,
            multiIf(gender_normalized = '', 'other', gender_normalized) AS gender,
            subscription AS subscription_plan,
            toString(utm_source_normalized) AS utm_source,
            utm_campaign, utm_adset, utm_adgroupid, utm_ad, utm_keyword
        FROM jobescape.jobescape_subscribed_users
        WHERE event_name = 'pr_funnel_subscribe'

        UNION ALL

        -- same gender / utm_source normalisation as the MATERIALIZED columns of jobescape_subscribed_users
        SELECT
            'sevenart' AS source,
            user_id,
            timestamp,
            age,
            multiIf(
                ifNull(gender, '') IN ('Male →', 'Hombre', 'Homme', 'Männlich', 'Uomo', 'Masculino'), 'male',
                ifNull(gender, '') IN ('Female →', 'Mujer', 'Femme', 'Weiblich', 'Donna', 'Feminino'), 'female',
                ifNull(gender, '') = 'No binario', 'non-binary',
                ifNull(gender, '') IN ('Prefer', 'I''d rather skip this one', 'Prefer not to say', 'Prefiero no especificar', 'Prefiero omitir esta pregunta', 'Je préfère ne pas répondre'), 'prefer not to say',
                lowerUTF8(ifNull(gender, '')) IN ('yes', 'other', 'no'), 'none',
                lowerUTF8(ifNull(gender, '')) = '', 'other',
                lowerUTF8(ifNull(gender, ''))
            ) AS gender,
            subscription AS subscription_plan,
            multiIf(
                lowerUTF8(ifNull(utm_source, '')) IN ('fb', 'fb_page', 'fb_post', 'instagram', 'facebook', 'insta_bio'), 'facebook',
                lowerUTF8(ifNull(utm_source, '')) = 'google', 'google',
                lowerUTF8(ifNull(utm_source, '')) = 'tiktok', 'tiktok',
                lowerUTF8(ifNull(utm_source, '')) = 'axon', 'axon',
                lowerUTF8(ifNull(utm_source, '')) IN ('landing_framer', 'landing_new'), 'landing',
                'other'
            ) AS utm_source,
            utm_campaign, utm_adset, utm_adgroupid, utm_ad, utm_keyword
        FROM sevenart.sevenart_subscribed_users
        WHERE event_name = 'pr_funnel_subscribe'
    )
    ORDER BY source, user_id, timestamp
    LIMIT 1 BY source, user_id
),

base AS (
    SELECT
        p.*,
        f.age AS age,
        -- payments with no subscribe event get 'other', same as before
        if(f.user_id = '', 'other', f.gender) AS gender,
        f.subscription_plan AS subscription_plan,
        f.utm_source AS utm_source,
        f.utm_campaign AS utm_campaign,
        f.utm_adset AS utm_adset,
        f.utm_adgroupid AS utm_adgroupid,
        f.utm_ad AS utm_ad,
        f.utm_keyword AS utm_keyword,
        if(p.source = 'sevenart', '7art', 'jobescape') AS product
    FROM pay p
    LEFT JOIN funnel f
        ON f.source = p.source
        AND f.user_id = p.user_id
),

refund_out AS (
    SELECT
        b.order_id AS order_id, b.user_id AS user_id, b.payment_type AS payment_type, b.payment_method AS payment_method,
        b.channel AS channel, b.utm_source AS utm_source, b.mid AS mid, b.issuing_bank AS issuing_bank,
        b.country_code AS country_code, b.cohort_date AS cohort_date, b.age AS age, b.gender AS gender,
        b.subscription_plan AS subscription_plan, b.utm_campaign AS utm_campaign, b.utm_adset AS utm_adset,
        b.utm_adgroupid AS utm_adgroupid, b.utm_ad AS utm_ad, b.utm_keyword AS utm_keyword,
        b.card_brand AS card_brand, b.subscription_id AS subscription_id, b.product AS product,
        -- never more than the payment itself
        least(r.refund_amount_minor, b.amount_minor) / 100 * ex.exchange_rate AS refund_amount,
        r.refund_created_at AS refund_created_at,
        r.refund_id AS refund_id,
        r.refund_reason AS refund_reason,
        r.refund_status AS refund_status,
        r.refund_type AS refund_type,
        r.support_agent_email AS support_agent_email
    FROM base b
    INNER JOIN refunds r ON r.order_id = b.order_id
    LEFT JOIN general.exchange_rate ex
        ON ex.date = toDate(r.refund_created_at)
        AND ex.currency = r.refund_currency
)

SELECT
    order_id, user_id AS customer_account_id, refund_amount AS amount, refund_created_at AS date,
    payment_type, payment_method, channel, utm_source, mid, issuing_bank, country_code AS geo_country,
    support_agent_email, refund_id, refund_reason, refund_status, refund_type, cohort_date,
    age, gender, subscription_plan, utm_campaign, utm_adset, utm_adgroupid, utm_ad,
    utm_keyword, NULL AS utm_placement, card_brand, subscription_id, 'refund' AS type, product
FROM refund_out

UNION ALL

SELECT
    order_id, user_id AS customer_account_id, amount, transaction_date AS date,
    payment_type, payment_method, channel, utm_source, mid, issuing_bank, country_code AS geo_country,
    '' AS support_agent_email, NULL AS refund_id, 'transaction' AS refund_reason,
    'transaction' AS refund_status, 'transaction' AS refund_type, cohort_date,
    age, gender, subscription_plan, utm_campaign, utm_adset, utm_adgroupid, utm_ad,
    utm_keyword, NULL AS utm_placement, card_brand, subscription_id, 'transaction' AS type, product
FROM base

UNION ALL

SELECT
    order_id, user_id AS customer_account_id, refund_amount AS amount, refund_created_at AS date,
    payment_type, payment_method, channel, utm_source, mid, issuing_bank, country_code AS geo_country,
    support_agent_email, refund_id, refund_reason, refund_status, refund_type, cohort_date,
    age, gender, subscription_plan, utm_campaign, utm_adset, utm_adgroupid, utm_ad,
    utm_keyword, NULL AS utm_placement, card_brand, subscription_id, 'refund_support' AS type, product
FROM refund_out
WHERE support_agent_email != ''
