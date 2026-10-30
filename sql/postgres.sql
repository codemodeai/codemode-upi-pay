-- codemode-upi-pay: tables and functions for PostgresStore (PostgreSQL 13+, Supabase, Neon, RDS...).
-- Safe to run more than once. PostgresStore.migrate() runs this file for you.
--
-- The same rules as src/rules.js:
--   unique amount per open payment (price + 1..99 paise), match by reference note then by unique amount,
--   alert window: 2 min before creation .. 30 min after expiry, UTR claims up to 48 h after expiry, 5 tries,
--   a UTR settles at most one payment.

create table if not exists upi_payments (
  id          text primary key,
  amount      numeric(14, 2) not null check (amount >= 1),          -- the price
  pay_amount  numeric(14, 2) not null,                              -- what the QR asks for (price + paise)
  ref         text not null unique,                                 -- UPI note, e.g. PAYK7Q2M9XH
  status      text not null default 'pending' check (status in ('pending', 'paid', 'underpaid')),
  order_id    text,
  customer    text,
  note        text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  paid_at     timestamptz,
  paid_amount numeric(14, 2),                                       -- what the bank says was paid
  utr         text unique,
  bank        text,
  payer       text,
  matched_by  text check (matched_by in ('ref', 'amount', 'utr')),
  utr_tries   integer not null default 0
);
create index if not exists upi_payments_open_idx on upi_payments (pay_amount) where status = 'pending';
create index if not exists upi_payments_order_idx on upi_payments (order_id);

-- Genuine UPI credit alerts read from the bank's emails.
create table if not exists upi_alerts (
  utr         text primary key check (utr ~ '^[0-9]{12}$'),
  amount      numeric(14, 2) not null check (amount > 0),
  bank        text,
  payer       text,
  ref         text,
  received_at timestamptz not null,                                 -- when Gmail received the email
  payment_id  text unique references upi_payments (id),
  created_at  timestamptz not null default now()
);
create index if not exists upi_alerts_open_idx on upi_alerts (received_at) where payment_id is null;

-- Where the inbox reader got to, and a throttle so only one reader runs at a time.
create table if not exists upi_sync (
  id           integer primary key default 1 check (id = 1),
  last_run     timestamptz not null default 'epoch',
  last_uid     bigint not null default 0,
  uid_validity bigint not null default 0,
  last_ok      timestamptz,
  last_error   text
);
insert into upi_sync (id) values (1) on conflict (id) do nothing;

-- On Supabase these tables would otherwise be readable through its public API. RLS with no policies = server only.
alter table upi_payments enable row level security;
alter table upi_alerts   enable row level security;
alter table upi_sync     enable row level security;

-- Start a payment with a free unique amount. Reopening the same order + amount while its QR is valid returns it.
create or replace function upi_create_payment(p_id text, p_amount numeric, p_ref text, p_minutes integer,
                                              p_order_id text, p_customer text, p_note text, p_metadata jsonb)
returns setof upi_payments
language plpgsql
as $$
declare
  r upi_payments%rowtype;
  paise integer;
begin
  if p_amount is null or p_amount < 1 or p_amount <> round(p_amount, 2) then
    raise exception 'BAD_AMOUNT';
  end if;
  perform pg_advisory_xact_lock(hashtext('upi_payment_alloc'));      -- one allocator at a time
  if p_order_id is not null then
    select * into r from upi_payments x
      where x.order_id = p_order_id and x.status = 'pending' and x.amount = p_amount and x.expires_at > now() + interval '2 minutes'
      order by x.created_at desc limit 1;
    if r.id is not null then
      return next r;
      return;
    end if;
    if (select count(*) from upi_payments x where x.order_id = p_order_id and x.status = 'pending' and x.expires_at > now()) >= 5 then
      raise exception 'TOO_MANY_OPEN';
    end if;
  end if;
  select g into paise from generate_series(1, 99) g
    where not exists (select 1 from upi_payments x
                      where x.status = 'pending' and x.pay_amount = p_amount + g / 100.0
                        and x.expires_at > now() - interval '30 minutes')
      and not exists (select 1 from upi_alerts a
                      where a.payment_id is null and a.amount = p_amount + g / 100.0
                        and a.received_at > now() - interval '10 minutes')
    order by random() limit 1;
  if paise is null then
    raise exception 'NO_FREE_AMOUNT';
  end if;
  insert into upi_payments (id, amount, pay_amount, ref, order_id, customer, note, metadata, expires_at)
    values (p_id, p_amount, p_amount + paise / 100.0, p_ref, p_order_id, p_customer, p_note, coalesce(p_metadata, '{}'::jsonb),
            now() + make_interval(mins => p_minutes))
    returning * into r;
  return next r;
end;
$$;

-- Settle one payment with one alert, exactly once each. Returns the payment, or nothing if either was used.
create or replace function upi_settle(p_payment text, p_utr text, p_by text)
returns setof upi_payments
language plpgsql
as $$
declare
  r upi_payments%rowtype;
  a upi_alerts%rowtype;
begin
  select * into r from upi_payments where id = p_payment for update;
  select * into a from upi_alerts where utr = p_utr for update;
  if r.id is null or a.utr is null or r.status <> 'pending' or a.payment_id is not null then
    return;
  end if;
  update upi_alerts set payment_id = r.id where utr = a.utr;
  update upi_payments set status = case when a.amount >= r.pay_amount then 'paid' else 'underpaid' end,
    paid_at = now(), paid_amount = a.amount, utr = a.utr, bank = a.bank, payer = a.payer, matched_by = p_by
    where id = r.id
    returning * into r;
  return next r;
end;
$$;

-- Match unmatched alerts to open payments: by reference note first, then by the unique amount.
create or replace function upi_match_alerts()
returns setof upi_payments
language plpgsql
as $$
declare
  a upi_alerts%rowtype;
  pid text;
  how text;
  r upi_payments%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('upi_match'));
  for a in select * from upi_alerts u
           where u.payment_id is null and u.received_at > now() - interval '3 days'
           order by u.received_at
  loop
    pid := null;
    if a.ref is not null then
      select x.id into pid from upi_payments x
        where x.status = 'pending' and x.ref = a.ref
          and a.received_at between x.created_at - interval '2 minutes' and x.expires_at + interval '30 minutes';
      how := 'ref';
    end if;
    if pid is null then
      select min(x.id) into pid from upi_payments x
        where x.status = 'pending' and x.pay_amount = a.amount
          and a.received_at between x.created_at - interval '2 minutes' and x.expires_at + interval '30 minutes'
        having count(*) = 1;
      how := 'amount';
    end if;
    if pid is not null then
      for r in select * from upi_settle(pid, a.utr, how) loop
        return next r;
      end loop;
    end if;
  end loop;
end;
$$;

-- Save alerts read from the inbox (repeats are ignored) and match them. Returns the payments that got settled.
create or replace function upi_ingest_alerts(p_alerts jsonb)
returns setof upi_payments
language plpgsql
as $$
begin
  insert into upi_alerts (utr, amount, bank, payer, ref, received_at)
    select e->>'utr', (e->>'amount')::numeric, left(e->>'bank', 60), left(e->>'payer', 120), nullif(e->>'ref', ''),
           least((e->>'receivedAt')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) e
    where e->>'utr' ~ '^[0-9]{12}$' and e->>'amount' ~ '^[0-9]+(\.[0-9]{1,2})?$'
  on conflict (utr) do nothing;
  return query select * from upi_match_alerts();
end;
$$;

-- "I've paid": the customer gives the UTR from their UPI app. Returns {result, settled}:
-- result is 'paid' / 'underpaid' (settled now or before), 'not_found' or 'used'.
create or replace function upi_claim_utr(p_payment text, p_utr text)
returns json
language plpgsql
as $$
declare
  r upi_payments%rowtype;
  a upi_alerts%rowtype;
  s upi_payments%rowtype;
begin
  select * into r from upi_payments where id = p_payment for update;
  if r.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if r.status <> 'pending' then
    return json_build_object('result', r.status, 'settled', false);
  end if;
  if r.utr_tries >= 5 then
    raise exception 'TOO_MANY_TRIES';
  end if;
  update upi_payments set utr_tries = utr_tries + 1 where id = r.id;
  select * into a from upi_alerts where utr = p_utr;
  if a.utr is null or a.received_at not between r.created_at - interval '2 minutes' and r.expires_at + interval '48 hours' then
    return json_build_object('result', 'not_found', 'settled', false);
  end if;
  if a.payment_id is not null then
    return json_build_object('result', 'used', 'settled', false);
  end if;
  select * into s from upi_settle(r.id, a.utr, 'utr');
  return json_build_object('result', s.status, 'settled', true);
end;
$$;

-- Inbox reader throttle: returns where to continue from, only if no reader ran in the last p_min_seconds.
create or replace function upi_claim_sync(p_min_seconds integer)
returns table (last_uid bigint, uid_validity bigint)
language sql
as $$
  update upi_sync s set last_run = now()
    where s.id = 1 and s.last_run < now() - make_interval(secs => p_min_seconds)
    returning s.last_uid, s.uid_validity;
$$;

create or replace function upi_finish_sync(p_last_uid bigint, p_uid_validity bigint, p_error text)
returns void
language sql
as $$
  update upi_sync set
    last_uid     = case when p_last_uid is null then last_uid
                        when p_uid_validity = uid_validity then greatest(last_uid, p_last_uid)
                        else p_last_uid end,
    uid_validity = coalesce(p_uid_validity, uid_validity),
    last_ok      = case when p_error is null then now() else last_ok end,
    last_error   = left(p_error, 300)
  where id = 1;
$$;
