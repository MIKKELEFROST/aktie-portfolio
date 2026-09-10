# Database (Supabase)

Appen har brug for ét sted at gemme to ting: porteføljen og – hvis du bruger login –
adgangskoden. Alt andet (kurser, afkast, grafer) regnes ud på farten.

Vil du hellere bruge Upstash Redis, skal du ikke gøre noget her: Vercel sætter selv
variablerne, når du forbinder databasen under *Storage*. Se README.

## 1. Opret projektet

Opret et gratis projekt på [supabase.com](https://supabase.com). Vælg en region tæt på dig
(`eu-central-1` i Frankfurt er nærmest for danske brugere).

## 2. Kør SQL'en

Åbn *SQL Editor* i Supabase, indsæt det hele, og kør det.

```sql
-- Nøgle/værdi-lager. To rækker i praksis:
--   aktie:portfolio = beholdninger, depoter og indstillinger
--   aktie:auth      = adgangskode-hash og session-nøgle (bruges ikke ved åben adgang)
create table public.kv (
  key         text primary key,
  value       jsonb       not null,
  rev         text        not null,
  updated_at  timestamptz not null default now()
);

-- Sikkerhedskopier: de seneste versioner af hver nøgle.
create table public.kv_backups (
  id         bigserial primary key,
  key        text        not null,
  value      jsonb       not null,
  created_at timestamptz not null default now()
);
create index kv_backups_key_id_idx on public.kv_backups (key, id desc);

create or replace function public.kv_get(p_key text)
returns table (value jsonb, rev text)
language sql security definer set search_path = public stable as $$
  select k.value, k.rev from public.kv k where k.key = p_key;
$$;

-- Skriv kun hvis ingen anden enhed har ændret rækken imens (compare-and-set).
-- Returnerer false ved konflikt, så serveren kan læse igen og prøve forfra.
create or replace function public.kv_cas(
  p_key text, p_value jsonb, p_rev text, p_new_rev text, p_backups int default 5
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_current text;
  v_old     jsonb;
begin
  select rev, value into v_current, v_old from public.kv where key = p_key for update;

  if v_current is null then
    if coalesce(p_rev, '') <> '' then
      return false; -- vi troede rækken fandtes; den er væk, læs igen
    end if;
    insert into public.kv (key, value, rev) values (p_key, p_value, p_new_rev);
    return true;
  end if;

  if v_current <> coalesce(p_rev, '') then
    return false;
  end if;

  update public.kv set value = p_value, rev = p_new_rev, updated_at = now() where key = p_key;

  if p_backups > 0 then
    insert into public.kv_backups (key, value) values (p_key, v_old);
    delete from public.kv_backups b
     where b.key = p_key
       and b.id not in (select id from public.kv_backups where key = p_key order by id desc limit p_backups);
  end if;

  return true;
end;
$$;

-- Tabellerne lukkes helt for API-nøglen; kun de to funktioner må kaldes.
-- En lækket nøgle kan derfor hverken slette data eller læse sikkerhedskopierne.
alter table public.kv         enable row level security;
alter table public.kv_backups enable row level security;
revoke all on public.kv         from anon, authenticated;
revoke all on public.kv_backups from anon, authenticated;
revoke all on function public.kv_cas(text, jsonb, text, text, int) from public;
revoke all on function public.kv_get(text) from public;
grant execute on function public.kv_get(text) to anon;
grant execute on function public.kv_cas(text, jsonb, text, text, int) to anon;
```

## 3. Sæt miljøvariablerne

I Vercel: *Settings → Environment Variables*.

| Variabel | Hvor finder du den |
|---|---|
| `SUPABASE_URL` | Supabase → *Project Settings → Data API → Project URL* |
| `SUPABASE_KEY` | Samme side → *API Keys* → den **publishable** (`sb_publishable_…`) |

Derefter *Deployments → ⋯ → Redeploy*.

Uden `DASHBOARD_PASSWORD` er siden åben: porteføljen vises til alle, der kender adressen.
Det er meningen, hvis du vil kunne åbne den fra hvilken som helst browser uden at logge ind.

## Godt at vide

- **Samtidige ændringer.** Skriver to enheder på én gang, opdager `kv_cas` det og serveren
  læser og prøver igen – i stedet for at den ene overskriver den anden.
- **Sikkerhedskopier.** De fem seneste versioner af porteføljen ligger i `kv_backups`.
  Sådan hentes den forrige tilbage:
  ```sql
  update public.kv set value = (select value from public.kv_backups where key = 'aktie:portfolio' order by id desc limit 1),
                       rev   = gen_random_uuid()::text
   where key = 'aktie:portfolio';
  ```
  Du kan også bruge *Indstillinger → Download sikkerhedskopi* i appen.
- **Gratis-planen** har en månedlig grænse for udgående trafik på tværs af *alle* projekter i
  organisationen. Rammes den, svarer API'et `HTTP 402 exceed_egress_quota`, og appen viser
  det som en fejl. Appen selv bruger meget lidt, men et andet projekt i samme organisation
  kan opbruge kvoten.
